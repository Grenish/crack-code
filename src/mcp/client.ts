// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — MCP Client
// ─────────────────────────────────────────────────────────────────────────────
// Implements a lightweight MCP (Model Context Protocol) client that
// communicates with external MCP servers via stdin/stdout subprocess
// spawning using JSON-RPC 2.0 messaging.
//
// The client supports:
//   • Spawning MCP server processes with configurable commands/args
//   • JSON-RPC 2.0 request/response/notification messaging
//   • Capability negotiation (initialize handshake)
//   • Tool listing and invocation
//   • Resource listing and reading
//   • Graceful shutdown and process cleanup
//   • Timeout handling for unresponsive servers
//
// Zero external dependencies — uses only Node built-in child_process, events.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

// ── JSON-RPC 2.0 Types ─────────────────────────────────────────────────────

/** A JSON-RPC 2.0 request message */
interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/** A JSON-RPC 2.0 response message */
interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** A JSON-RPC 2.0 notification (no id, no response expected) */
interface JSONRPCNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse | JSONRPCNotification;

// ── MCP Protocol Types ──────────────────────────────────────────────────────

/** MCP server capabilities returned during initialization */
export interface MCPServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

/** MCP server info returned during initialization */
export interface MCPServerInfo {
  name: string;
  version: string;
}

/** Result of the MCP initialize handshake */
export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: MCPServerCapabilities;
  serverInfo: MCPServerInfo;
}

/** An MCP tool descriptor (returned by tools/list) */
export interface MCPToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** Content block in a tool call result */
export interface MCPContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** Result of calling an MCP tool */
export interface MCPToolCallResult {
  content: MCPContentBlock[];
  isError?: boolean;
}

/** An MCP resource descriptor (returned by resources/list) */
export interface MCPResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** Result of reading an MCP resource */
export interface MCPResourceReadResult {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  }>;
}

// ── MCP Client Configuration ────────────────────────────────────────────────

/** Configuration for spawning an MCP server */
export interface MCPServerConfig {
  /** Unique name/identifier for this server */
  name: string;
  /** Command to execute (e.g. "npx", "uvx", "node") */
  command: string;
  /** Arguments to pass to the command */
  args: string[];
  /** Environment variables to set for the subprocess */
  env?: Record<string, string>;
  /** Working directory for the subprocess */
  cwd?: string;
  /** Timeout for requests in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Whether to auto-initialize on connect (default: true) */
  autoInitialize?: boolean;
}

/** Connection status of an MCP server */
export type MCPConnectionStatus =
  | "disconnected"
  | "connecting"
  | "initializing"
  | "ready"
  | "error"
  | "closed";

// ── Pending Request Tracking ────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── MCP Client Class ────────────────────────────────────────────────────────

/**
 * MCP Client — communicates with a single MCP server process.
 *
 * Lifecycle:
 *   1. `connect()` — spawn the server subprocess
 *   2. `initialize()` — perform MCP handshake (auto-called if autoInitialize=true)
 *   3. `listTools()` / `callTool()` / `listResources()` / `readResource()` — use the server
 *   4. `disconnect()` — gracefully shut down
 *
 * Events emitted:
 *   - "statusChange" (status: MCPConnectionStatus)
 *   - "notification" (method: string, params: unknown)
 *   - "error" (error: Error)
 *   - "log" (level: string, message: string)
 */
export class MCPClient extends EventEmitter {
  /** Server configuration */
  public readonly config: MCPServerConfig;

  /** Current connection status */
  private _status: MCPConnectionStatus = "disconnected";

  /** The spawned server subprocess */
  private process: ChildProcess | null = null;

  /** Server capabilities (populated after initialize) */
  private serverCapabilities: MCPServerCapabilities | null = null;

  /** Server info (populated after initialize) */
  private serverInfo: MCPServerInfo | null = null;

  /** Cached list of tools (populated after listTools) */
  private cachedTools: MCPToolDescriptor[] | null = null;

  /** Map of pending request ID → resolver/rejecter */
  private pendingRequests: Map<string | number, PendingRequest> = new Map();

  /** Incrementing request ID counter */
  private nextId: number = 1;

  /** Default timeout for requests */
  private readonly timeoutMs: number;

  /** Buffer for incomplete JSON-RPC messages (line-delimited protocol) */
  private stdoutBuffer: string = "";

  constructor(config: MCPServerConfig) {
    super();
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  // ── Status ────────────────────────────────────────────────────────────

  /** Get the current connection status */
  get status(): MCPConnectionStatus {
    return this._status;
  }

  /** Whether the client is connected and ready to accept requests */
  get isReady(): boolean {
    return this._status === "ready";
  }

  /** Whether the client has an active connection (may not be ready yet) */
  get isConnected(): boolean {
    return (
      this._status === "connecting" ||
      this._status === "initializing" ||
      this._status === "ready"
    );
  }

  /** Get the server capabilities (available after initialization) */
  getCapabilities(): MCPServerCapabilities | null {
    return this.serverCapabilities;
  }

  /** Get the server info (available after initialization) */
  getServerInfo(): MCPServerInfo | null {
    return this.serverInfo;
  }

  /** Get cached tools list (call listTools() first to populate) */
  getCachedTools(): MCPToolDescriptor[] | null {
    return this.cachedTools;
  }

  // ── Connection Lifecycle ──────────────────────────────────────────────

  /**
   * Connect to the MCP server by spawning the subprocess.
   *
   * If `autoInitialize` is true (default), also performs the MCP
   * initialize handshake.
   *
   * @returns The initialize result if auto-initialized, or null.
   */
  async connect(): Promise<MCPInitializeResult | null> {
    if (this.isConnected) {
      throw new Error(
        `MCP client "${this.config.name}" is already connected (status: ${this._status}).`
      );
    }

    this.setStatus("connecting");

    try {
      // Build environment variables
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...(this.config.env ?? {}),
      };

      // Spawn the server process
      this.process = spawn(this.config.command, this.config.args, {
        cwd: this.config.cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        // Don't let the child process keep the parent alive
        detached: false,
      });

      // Wire up event handlers
      this.setupProcessHandlers();

      // Wait a short time to ensure the process didn't immediately crash
      await this.waitForProcessReady();

      // Auto-initialize if configured
      const autoInit = this.config.autoInitialize ?? true;
      if (autoInit) {
        const result = await this.initialize();
        return result;
      }

      this.setStatus("ready");
      return null;
    } catch (err) {
      this.setStatus("error");
      const error =
        err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
      throw error;
    }
  }

  /**
   * Perform the MCP initialize handshake.
   *
   * This sends the `initialize` request and then the `initialized`
   * notification, establishing the MCP session.
   */
  async initialize(): Promise<MCPInitializeResult> {
    this.setStatus("initializing");

    try {
      const result = (await this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {
          // Client capabilities — we support tool calling
          roots: { listChanged: false },
          sampling: {},
        },
        clientInfo: {
          name: "crack-code",
          version: "0.1.0",
        },
      })) as MCPInitializeResult;

      this.serverCapabilities = result.capabilities;
      this.serverInfo = result.serverInfo;

      // Send the "initialized" notification to complete the handshake
      this.sendNotification("notifications/initialized", {});

      this.setStatus("ready");
      this.emitLog(
        "info",
        `Connected to MCP server "${result.serverInfo?.name ?? this.config.name}" ` +
          `v${result.serverInfo?.version ?? "unknown"}`
      );

      return result;
    } catch (err) {
      this.setStatus("error");
      throw err;
    }
  }

  /**
   * Gracefully disconnect from the MCP server.
   *
   * Sends a shutdown request, then kills the subprocess.
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected && this._status !== "error") {
      return; // Already disconnected
    }

    try {
      // Try to send a graceful shutdown if we're ready
      if (this._status === "ready") {
        try {
          await this.sendRequest("shutdown", {});
        } catch {
          // Ignore shutdown errors — we're disconnecting anyway
        }
      }
    } finally {
      this.cleanup();
    }
  }

  // ── Tool Operations ───────────────────────────────────────────────────

  /**
   * List available tools on the MCP server.
   *
   * Caches the result — call with `refresh: true` to force re-fetch.
   */
  async listTools(refresh: boolean = false): Promise<MCPToolDescriptor[]> {
    this.ensureReady();

    if (this.cachedTools && !refresh) {
      return this.cachedTools;
    }

    const result = (await this.sendRequest("tools/list", {})) as {
      tools: MCPToolDescriptor[];
    };

    this.cachedTools = result.tools ?? [];
    return this.cachedTools;
  }

  /**
   * Call a tool on the MCP server.
   *
   * @param toolName  - Name of the tool to invoke.
   * @param arguments_ - Arguments to pass to the tool.
   * @returns The tool call result containing content blocks.
   */
  async callTool(
    toolName: string,
    arguments_: Record<string, unknown> = {}
  ): Promise<MCPToolCallResult> {
    this.ensureReady();

    const result = (await this.sendRequest("tools/call", {
      name: toolName,
      arguments: arguments_,
    })) as MCPToolCallResult;

    return result;
  }

  /**
   * Call a tool and return the text content as a simple string.
   *
   * This is a convenience wrapper around callTool() that extracts
   * and concatenates all text content blocks.
   */
  async callToolText(
    toolName: string,
    arguments_: Record<string, unknown> = {}
  ): Promise<{ success: boolean; text: string; error?: string }> {
    try {
      const result = await this.callTool(toolName, arguments_);

      const text = result.content
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text!)
        .join("\n");

      return {
        success: !result.isError,
        text,
        error: result.isError ? text : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        text: "",
        error: message,
      };
    }
  }

  // ── Resource Operations ───────────────────────────────────────────────

  /**
   * List available resources on the MCP server.
   */
  async listResources(): Promise<MCPResourceDescriptor[]> {
    this.ensureReady();

    const result = (await this.sendRequest("resources/list", {})) as {
      resources: MCPResourceDescriptor[];
    };

    return result.resources ?? [];
  }

  /**
   * Read a resource from the MCP server.
   *
   * @param uri - The resource URI to read.
   */
  async readResource(uri: string): Promise<MCPResourceReadResult> {
    this.ensureReady();

    const result = (await this.sendRequest("resources/read", {
      uri,
    })) as MCPResourceReadResult;

    return result;
  }

  // ── JSON-RPC Messaging ────────────────────────────────────────────────

  /**
   * Send a JSON-RPC 2.0 request and wait for the response.
   *
   * @param method - The method to invoke.
   * @param params - Parameters for the method.
   * @returns The result field from the JSON-RPC response.
   * @throws Error if the request times out or the server returns an error.
   */
  sendRequest(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(
          new Error(
            `Cannot send request: MCP server "${this.config.name}" stdin is not writable.`
          )
        );
        return;
      }

      const id = this.nextId++;

      const request: JSONRPCRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      // Set up timeout
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `MCP request "${method}" to "${this.config.name}" timed out after ${this.timeoutMs}ms.`
          )
        );
      }, this.timeoutMs);

      // Track the pending request
      this.pendingRequests.set(id, { resolve, reject, timer });

      // Write the request as a newline-delimited JSON message
      const message = JSON.stringify(request) + "\n";

      try {
        this.process.stdin.write(message, "utf-8", (err) => {
          if (err) {
            this.pendingRequests.delete(id);
            clearTimeout(timer);
            reject(
              new Error(
                `Failed to write to MCP server "${this.config.name}": ${err.message}`
              )
            );
          }
        });
      } catch (err) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(
          err instanceof Error ? err : new Error(String(err))
        );
      }
    });
  }

  /**
   * Send a JSON-RPC 2.0 notification (fire-and-forget, no response expected).
   *
   * @param method - The notification method.
   * @param params - Parameters for the notification.
   */
  sendNotification(
    method: string,
    params: Record<string, unknown> = {}
  ): void {
    if (!this.process?.stdin?.writable) {
      this.emitLog(
        "warn",
        `Cannot send notification "${method}": stdin not writable.`
      );
      return;
    }

    const notification: JSONRPCNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const message = JSON.stringify(notification) + "\n";

    try {
      this.process.stdin.write(message, "utf-8");
    } catch {
      this.emitLog(
        "warn",
        `Failed to send notification "${method}" to "${this.config.name}".`
      );
    }
  }

  // ── Internal: Process Management ──────────────────────────────────────

  /**
   * Set up event handlers on the spawned subprocess.
   */
  private setupProcessHandlers(): void {
    if (!this.process) return;

    // Handle stdout data (JSON-RPC responses)
    this.process.stdout?.on("data", (chunk: Buffer) => {
      this.handleStdoutData(chunk.toString("utf-8"));
    });

    // Handle stderr (logging/diagnostics from the server)
    this.process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        this.emitLog("debug", `[${this.config.name} stderr] ${text}`);
      }
    });

    // Handle process exit
    this.process.on("exit", (code, signal) => {
      this.emitLog(
        "info",
        `MCP server "${this.config.name}" exited (code=${code}, signal=${signal}).`
      );

      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(
            `MCP server "${this.config.name}" exited unexpectedly (code=${code}).`
          )
        );
      }
      this.pendingRequests.clear();

      this.process = null;
      this.setStatus("closed");
    });

    // Handle process errors (e.g. command not found)
    this.process.on("error", (err) => {
      this.emitLog("error", `MCP process error: ${err.message}`);
      this.emit("error", err);

      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pendingRequests.clear();

      this.setStatus("error");
    });
  }

  /**
   * Handle incoming data on stdout.
   *
   * MCP uses newline-delimited JSON-RPC 2.0 messages. We buffer
   * partial lines and process complete ones.
   */
  private handleStdoutData(data: string): void {
    this.stdoutBuffer += data;

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const message = JSON.parse(line) as JSONRPCMessage;
        this.handleMessage(message);
      } catch {
        this.emitLog(
          "warn",
          `Failed to parse JSON-RPC message from "${this.config.name}": ${line.slice(0, 200)}`
        );
      }
    }
  }

  /**
   * Handle a parsed JSON-RPC message.
   */
  private handleMessage(message: JSONRPCMessage): void {
    // Response (has "id" and either "result" or "error")
    if ("id" in message && message.id !== null && message.id !== undefined) {
      if ("result" in message || "error" in message) {
        this.handleResponse(message as JSONRPCResponse);
        return;
      }
    }

    // Notification (has "method" but no "id")
    if ("method" in message && !("id" in message)) {
      this.handleNotification(message as JSONRPCNotification);
      return;
    }

    // Request from server (has "method" and "id") — log but we don't handle server-initiated requests yet
    if ("method" in message && "id" in message) {
      this.emitLog(
        "debug",
        `Received server request "${(message as JSONRPCRequest).method}" — not handled.`
      );
      // Send an error response back
      if (this.process?.stdin?.writable) {
        const errorResponse: JSONRPCResponse = {
          jsonrpc: "2.0",
          id: (message as JSONRPCRequest).id,
          error: {
            code: -32601,
            message: "Method not found — client does not handle server-initiated requests.",
          },
        };
        const responseStr = JSON.stringify(errorResponse) + "\n";
        try {
          this.process.stdin.write(responseStr, "utf-8");
        } catch {
          // Ignore write errors
        }
      }
      return;
    }
  }

  /**
   * Handle a JSON-RPC response (matching it to a pending request).
   */
  private handleResponse(response: JSONRPCResponse): void {
    const pending = this.pendingRequests.get(response.id!);
    if (!pending) {
      this.emitLog(
        "warn",
        `Received response for unknown request ID: ${response.id}`
      );
      return;
    }

    // Clean up
    this.pendingRequests.delete(response.id!);
    clearTimeout(pending.timer);

    // Resolve or reject
    if (response.error) {
      pending.reject(
        new Error(
          `MCP error (${response.error.code}): ${response.error.message}` +
            (response.error.data
              ? `\nData: ${JSON.stringify(response.error.data)}`
              : "")
        )
      );
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handle a JSON-RPC notification from the server.
   */
  private handleNotification(notification: JSONRPCNotification): void {
    this.emit("notification", notification.method, notification.params);

    // Handle specific notifications
    switch (notification.method) {
      case "notifications/tools/list_changed":
        // Invalidate the tool cache
        this.cachedTools = null;
        this.emitLog("info", `Tools list changed on "${this.config.name}".`);
        break;

      case "notifications/resources/list_changed":
        this.emitLog(
          "info",
          `Resources list changed on "${this.config.name}".`
        );
        break;

      case "notifications/message":
        // Log message from server
        const params = notification.params as Record<string, unknown> | undefined;
        const level = String(params?.["level"] ?? "info");
        const logMessage = String(params?.["data"] ?? params?.["message"] ?? "");
        this.emitLog(level, `[${this.config.name}] ${logMessage}`);
        break;

      default:
        this.emitLog(
          "debug",
          `Received notification: ${notification.method}`
        );
    }
  }

  /**
   * Wait briefly for the process to be ready (not immediately crashed).
   */
  private waitForProcessReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.process) {
        reject(new Error("Process was not spawned."));
        return;
      }

      // If the process exits immediately, that's an error
      const onExit = (code: number | null): void => {
        cleanup();
        reject(
          new Error(
            `MCP server "${this.config.name}" exited immediately (code=${code}). ` +
              `Command: ${this.config.command} ${this.config.args.join(" ")}`
          )
        );
      };

      const onError = (err: Error): void => {
        cleanup();
        reject(
          new Error(
            `Failed to start MCP server "${this.config.name}": ${err.message}. ` +
              `Command: ${this.config.command} ${this.config.args.join(" ")}`
          )
        );
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(); // Process is still running after delay — assume it's ready
      }, 500);

      const cleanup = (): void => {
        clearTimeout(timer);
        this.process?.removeListener("exit", onExit);
        this.process?.removeListener("error", onError);
      };

      this.process.once("exit", onExit);
      this.process.once("error", onError);
    });
  }

  /**
   * Ensure the client is in the "ready" state.
   * @throws Error if not ready.
   */
  private ensureReady(): void {
    if (this._status !== "ready") {
      throw new Error(
        `MCP client "${this.config.name}" is not ready (status: ${this._status}). ` +
          "Call connect() first."
      );
    }
  }

  /**
   * Clean up the subprocess and internal state.
   */
  private cleanup(): void {
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`MCP client "${this.config.name}" disconnected.`)
      );
    }
    this.pendingRequests.clear();

    // Kill the subprocess
    if (this.process) {
      try {
        // Try SIGTERM first
        this.process.kill("SIGTERM");

        // Force kill after 3 seconds if still alive
        const forceKillTimer = setTimeout(() => {
          try {
            if (this.process && !this.process.killed) {
              this.process.kill("SIGKILL");
            }
          } catch {
            // Process already dead
          }
        }, 3000);

        // Don't keep the Node process alive for this timer
        if (forceKillTimer.unref) {
          forceKillTimer.unref();
        }
      } catch {
        // Process already dead or not started
      }

      this.process = null;
    }

    // Clear state
    this.stdoutBuffer = "";
    this.serverCapabilities = null;
    this.serverInfo = null;
    this.cachedTools = null;

    this.setStatus("disconnected");
  }

  /**
   * Update the connection status and emit a change event.
   */
  private setStatus(status: MCPConnectionStatus): void {
    const previous = this._status;
    this._status = status;
    if (previous !== status) {
      this.emit("statusChange", status, previous);
    }
  }

  /**
   * Emit a log event.
   */
  private emitLog(level: string, message: string): void {
    this.emit("log", level, message);
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a new MCP client for the given server configuration.
 *
 * Does NOT connect — call `client.connect()` to start the server process.
 */
export function createMCPClient(config: MCPServerConfig): MCPClient {
  return new MCPClient(config);
}

/**
 * Create an MCP client, connect to the server, and return it ready to use.
 *
 * This is a convenience function that combines construction + connection.
 *
 * @param config - Server configuration.
 * @returns The connected and initialized MCPClient.
 * @throws Error if connection or initialization fails.
 */
export async function connectMCPServer(
  config: MCPServerConfig
): Promise<MCPClient> {
  const client = createMCPClient(config);
  await client.connect();
  return client;
}

/**
 * Create a simple MCP call function from a connected client.
 *
 * Returns a function matching the ToolContext.mcpCall signature:
 *   (serverName, method, params) => Promise<{ success, result, error? }>
 *
 * This is the bridge between the built-in tools and MCP servers.
 */
export function createMCPCallFunction(
  clients: Map<string, MCPClient>
): (
  serverName: string,
  method: string,
  params: Record<string, unknown>
) => Promise<{ success: boolean; result: unknown; error?: string }> {
  return async (
    serverName: string,
    method: string,
    params: Record<string, unknown>
  ) => {
    const client = clients.get(serverName);

    if (!client) {
      // Try to find a client by partial name match
      const matchingKey = Array.from(clients.keys()).find(
        (key) =>
          key.toLowerCase().includes(serverName.toLowerCase()) ||
          serverName.toLowerCase().includes(key.toLowerCase())
      );

      const matchedClient = matchingKey
        ? clients.get(matchingKey)
        : undefined;

      if (!matchedClient) {
        return {
          success: false,
          result: null,
          error: `MCP server "${serverName}" is not connected. Available: ${Array.from(clients.keys()).join(", ") || "(none)"}`,
        };
      }

      return executeMCPMethod(matchedClient, method, params);
    }

    return executeMCPMethod(client, method, params);
  };
}

/**
 * Execute an MCP method on a client, routing to the appropriate protocol method.
 */
async function executeMCPMethod(
  client: MCPClient,
  method: string,
  params: Record<string, unknown>
): Promise<{ success: boolean; result: unknown; error?: string }> {
  if (!client.isReady) {
    return {
      success: false,
      result: null,
      error: `MCP server "${client.config.name}" is not ready (status: ${client.status}).`,
    };
  }

  try {
    // Route known methods to typed client methods
    switch (method) {
      case "search":
      case "web-search":
      case "brave_web_search":
      case "serper_search":
      case "tavily_search": {
        // Try to find a search-like tool
        const tools = await client.listTools();
        const searchTool = tools.find(
          (t) =>
            t.name.toLowerCase().includes("search") ||
            t.name.toLowerCase().includes("query") ||
            t.name.toLowerCase().includes("web")
        );

        if (searchTool) {
          const result = await client.callTool(searchTool.name, params);
          const text = result.content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
          return {
            success: !result.isError,
            result: text || result.content,
            error: result.isError ? text : undefined,
          };
        }

        // Fall through to generic call
        const rawResult = await client.sendRequest(method, params);
        return { success: true, result: rawResult };
      }

      case "tools/list": {
        const tools = await client.listTools(true);
        return { success: true, result: tools };
      }

      case "tools/call": {
        const toolName = String(params["name"] ?? "");
        const toolArgs =
          (params["arguments"] as Record<string, unknown>) ?? {};
        const result = await client.callTool(toolName, toolArgs);
        const text = result.content
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text!)
          .join("\n");
        return {
          success: !result.isError,
          result: text || result.content,
          error: result.isError ? text : undefined,
        };
      }

      case "resources/list": {
        const resources = await client.listResources();
        return { success: true, result: resources };
      }

      case "resources/read": {
        const uri = String(params["uri"] ?? "");
        const result = await client.readResource(uri);
        return { success: true, result };
      }

      default: {
        // Try as a tool call first
        try {
          const result = await client.callTool(method, params);
          const text = result.content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
          return {
            success: !result.isError,
            result: text || result.content,
            error: result.isError ? text : undefined,
          };
        } catch {
          // Fall back to raw JSON-RPC
          const rawResult = await client.sendRequest(method, params);
          return { success: true, result: rawResult };
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      result: null,
      error: message,
    };
  }
}

// ── Health Check ────────────────────────────────────────────────────────────

/**
 * Perform a health check on an MCP server by connecting, listing tools,
 * and disconnecting.
 *
 * @param config - Server configuration.
 * @returns Health check result.
 */
export async function checkMCPServerHealth(
  config: MCPServerConfig
): Promise<{
  healthy: boolean;
  serverName: string;
  serverVersion: string;
  toolCount: number;
  error?: string;
  latencyMs: number;
}> {
  const startMs = Date.now();

  try {
    const client = createMCPClient({
      ...config,
      timeoutMs: Math.min(config.timeoutMs ?? 30_000, 15_000),
    });

    await client.connect();

    const tools = await client.listTools();
    const info = client.getServerInfo();

    await client.disconnect();

    return {
      healthy: true,
      serverName: info?.name ?? config.name,
      serverVersion: info?.version ?? "unknown",
      toolCount: tools.length,
      latencyMs: Date.now() - startMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      healthy: false,
      serverName: config.name,
      serverVersion: "unknown",
      toolCount: 0,
      error: message,
      latencyMs: Date.now() - startMs,
    };
  }
}
