// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Agent Orchestration
// ─────────────────────────────────────────────────────────────────────────────
// Manages the agentic loop that:
//   1. Accepts user messages and optional file context
//   2. Builds the conversation with system prompt + history
//   3. Sends requests to the active AI provider with tool definitions
//   4. Executes tool calls returned by the model
//   5. Feeds tool results back into the conversation
//   6. Repeats until the model produces a final text response
//   7. Records all calls in the session tracker
//
// The agent NEVER modifies source files. All tools are read-only.
// Tool results are returned to the model as tool_result messages.
//
// Zero external dependencies — uses only project modules.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  BaseProvider,
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolDefinition,
  ToolCall,
  ContentBlock,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  StreamDelta,
  StreamCallback,
  StreamingChatCompletionRequest,
  TokenUsage,
} from "../providers/base.js";

import {
  SYSTEM_PROMPT_PREFIX,
  MAX_CONVERSATION_TURNS,
  MAX_API_RETRIES,
  APP_NAME,
} from "../utils/constants.js";

import {
  getBuiltinToolDefinitions,
  executeBuiltinTool,
  isBuiltinTool,
  type ToolContext,
  type ToolExecutionResult,
} from "../tools/builtin/index.js";

import { getSession } from "../cli/session.js";
import { appendAuditLog } from "../config/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Configuration for the agent.
 */
export interface AgentConfig {
  /** The AI provider instance to use */
  provider: BaseProvider;
  /** Model ID to use for completions */
  model: string;
  /** The project root path (for tool execution) */
  projectRoot: string;
  /** Whether MCP is enabled */
  mcpEnabled: boolean;
  /** MCP call function (if MCP is enabled) */
  mcpCall?: (
    serverName: string,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<{ success: boolean; result: unknown; error?: string }>;
  /** Custom system prompt additions (appended to SYSTEM_PROMPT_PREFIX) */
  systemPromptSuffix?: string;
  /** Additional context to include in the system prompt (e.g. project summary) */
  projectContext?: string;
  /** Maximum conversation turns before auto-summarization (default: MAX_CONVERSATION_TURNS) */
  maxTurns?: number;
  /** Maximum tool call iterations per user message (default: 15) */
  maxToolIterations?: number;
  /** Temperature for AI completions (default: provider-dependent) */
  temperature?: number;
  /** Max tokens for AI completions (default: 8192) */
  maxTokens?: number;
  /** Whether to stream responses (default: true) */
  streaming?: boolean;
  /** Callback for streaming deltas */
  onStreamDelta?: StreamCallback;
  /** Callback invoked when a tool call starts */
  onToolCallStart?: (toolName: string, input: Record<string, unknown>) => void;
  /** Callback invoked when a tool call finishes */
  onToolCallEnd?: (
    toolName: string,
    result: ToolExecutionResult,
    durationMs: number,
  ) => void;
  /** Callback invoked when a thinking/processing phase starts */
  onThinking?: (phase: string) => void;
  /** Custom tool definitions to include alongside built-in tools */
  customTools?: ToolDefinition[];
  /** Custom tool executor for custom tools */
  customToolExecutor?: (
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolExecutionResult>;
}

/**
 * Result of processing a single user message through the agent loop.
 */
export interface AgentResponse {
  /** Whether the agent produced a successful response */
  ok: boolean;
  /** The final text response from the agent */
  text: string;
  /** All content blocks from the final response */
  contentBlocks: ContentBlock[];
  /** Tool calls that were executed during this turn */
  toolCallsExecuted: ExecutedToolCall[];
  /** Total token usage across all API calls in this turn */
  totalUsage: TokenUsage;
  /** Total duration of this turn in milliseconds */
  durationMs: number;
  /** Number of API calls made during this turn */
  apiCallCount: number;
  /** Number of tool calls executed during this turn */
  toolCallCount: number;
  /** Error message if the agent failed */
  error?: string;
  /** The model that served the request */
  model: string;
  /** Whether the response was truncated (hit max iterations) */
  truncated: boolean;
}

/**
 * Record of a tool call that was executed.
 */
export interface ExecutedToolCall {
  /** Tool call ID */
  id: string;
  /** Tool name */
  name: string;
  /** Input arguments */
  input: Record<string, unknown>;
  /** Whether execution succeeded */
  success: boolean;
  /** Tool output content */
  output: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
}

/**
 * A conversation turn (for history management).
 */
export interface ConversationTurn {
  /** User's input message */
  userMessage: string;
  /** Agent's response text */
  agentResponse: string;
  /** Tool calls executed during this turn */
  toolCalls: ExecutedToolCall[];
  /** Timestamp */
  timestamp: string;
  /** Token usage */
  usage: TokenUsage;
}

// ── Agent Class ─────────────────────────────────────────────────────────────

/**
 * The Agent orchestrates the multi-turn conversation with the AI provider.
 *
 * It maintains conversation history, handles tool-calling loops, and
 * coordinates between the provider, built-in tools, custom tools, and
 * MCP servers.
 *
 * Usage:
 *   const agent = new Agent(config);
 *   const response = await agent.processMessage("Analyze src/auth.ts for vulnerabilities");
 */
export class Agent {
  /** Agent configuration */
  private readonly config: AgentConfig;

  /** Conversation history (user + assistant messages) */
  private history: ChatMessage[] = [];

  /** Completed conversation turns (for summarization) */
  private turns: ConversationTurn[] = [];

  /** The full system prompt (built once, cached) */
  private systemPrompt: string;

  /** All available tool definitions (built-in + custom) */
  private toolDefinitions: ToolDefinition[];

  /** Tool execution context */
  private toolContext: ToolContext;

  /** Whether the agent has been initialized */
  private initialized: boolean = false;

  constructor(config: AgentConfig) {
    this.config = config;

    // Build system prompt
    this.systemPrompt = this.buildSystemPrompt();

    // Build tool definitions
    this.toolDefinitions = [
      ...getBuiltinToolDefinitions(),
      ...(config.customTools ?? []),
    ];

    // Build tool context
    this.toolContext = {
      projectRoot: config.projectRoot,
      mcpEnabled: config.mcpEnabled,
      mcpCall: config.mcpCall,
    };

    this.initialized = true;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Process a user message through the full agent loop.
   *
   * This is the main entry point. It:
   *   1. Adds the user message to history
   *   2. Sends the conversation to the AI provider
   *   3. If the model requests tool calls, executes them
   *   4. Feeds tool results back and repeats
   *   5. Returns the final text response
   *
   * @param userMessage - The user's input message.
   * @param fileContext - Optional additional file context to include.
   * @returns The agent's response.
   */
  async processMessage(
    userMessage: string,
    fileContext?: string,
  ): Promise<AgentResponse> {
    const startMs = Date.now();
    const session = getSession();

    const maxIterations = this.config.maxToolIterations ?? 15;
    const executedToolCalls: ExecutedToolCall[] = [];
    let totalUsage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    let apiCallCount = 0;

    // ── Build the user message content ──────────────────────────────

    let fullUserContent = userMessage;
    if (fileContext) {
      fullUserContent += `\n\n--- File Context ---\n${fileContext}`;
    }

    // Add user message to history
    this.history.push({
      role: "user",
      content: fullUserContent,
    });

    // ── Check if we need to summarize history ───────────────────────

    const maxTurns = this.config.maxTurns ?? MAX_CONVERSATION_TURNS;
    if (this.turns.length > maxTurns) {
      await this.summarizeHistory();
    }

    // ── Agent loop ──────────────────────────────────────────────────

    let iteration = 0;
    let finalResponse: ChatCompletionResponse | null = null;
    let truncated = false;

    while (iteration < maxIterations) {
      iteration++;

      if (this.config.onThinking) {
        this.config.onThinking(
          iteration === 1
            ? "Thinking..."
            : `Processing (iteration ${iteration})...`,
        );
      }

      // Build the request
      const request = this.buildRequest();
      apiCallCount++;

      // Send to provider
      let response: ChatCompletionResponse;
      const apiStartMs = Date.now();

      try {
        if (this.config.streaming && this.config.onStreamDelta) {
          response = await this.config.provider.chatStream({
            ...request,
            onDelta: this.config.onStreamDelta,
          });
        } else {
          response = await this.config.provider.chatWithRetry(
            request,
            MAX_API_RETRIES,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const apiDurationMs = Date.now() - apiStartMs;

        session.recordAPIFailure(
          this.config.provider.getProviderId(),
          this.config.model,
          apiDurationMs,
        );

        // Add error to history so conversation can continue
        this.history.push({
          role: "assistant",
          content: `[Error: ${message}]`,
        });

        return {
          ok: false,
          text: "",
          contentBlocks: [],
          toolCallsExecuted: executedToolCalls,
          totalUsage,
          durationMs: Date.now() - startMs,
          apiCallCount,
          toolCallCount: executedToolCalls.length,
          error: message,
          model: this.config.model,
          truncated: false,
        };
      }

      const apiDurationMs = Date.now() - apiStartMs;

      // Record API call
      if (response.ok) {
        session.recordAPISuccess(
          this.config.provider.getProviderId(),
          this.config.model,
          apiDurationMs,
          response.usage.totalTokens,
        );
      } else {
        session.recordAPIFailure(
          this.config.provider.getProviderId(),
          this.config.model,
          apiDurationMs,
        );
      }

      // Accumulate usage
      totalUsage = addUsage(totalUsage, response.usage);

      // Check for errors
      if (!response.ok) {
        this.history.push({
          role: "assistant",
          content: response.error ?? "[Unknown error from provider]",
        });

        return {
          ok: false,
          text: "",
          contentBlocks: [],
          toolCallsExecuted: executedToolCalls,
          totalUsage,
          durationMs: Date.now() - startMs,
          apiCallCount,
          toolCallCount: executedToolCalls.length,
          error: response.error,
          model: response.model || this.config.model,
          truncated: false,
        };
      }

      // ── Check if the model wants to use tools ───────────────────

      if (response.stopReason === "tool_use" && response.toolCalls.length > 0) {
        // Add assistant message with tool-use content blocks to history
        this.history.push({
          role: "assistant",
          content: response.contentBlocks,
        });

        // Execute each tool call
        for (const toolCall of response.toolCalls) {
          const toolResult = await this.executeToolCall(toolCall);
          executedToolCalls.push(toolResult);

          // Record in session
          if (toolResult.success) {
            session.recordToolSuccess(toolResult.name, toolResult.durationMs);
          } else {
            session.recordToolFailure(
              toolResult.name,
              toolResult.durationMs,
              toolResult.error ?? "Unknown error",
            );
          }

          // Add tool result message to history
          this.history.push({
            role: "tool",
            content: [
              {
                type: "tool_result",
                toolUseId: toolCall.id,
                content: toolResult.output,
                isError: !toolResult.success,
              },
            ],
            toolUseId: toolCall.id,
          });
        }

        // Continue the loop — the model needs to process tool results
        continue;
      }

      // ── No tool calls — this is the final response ────────────

      finalResponse = response;

      // Add assistant response to history
      if (response.contentBlocks.length > 0) {
        this.history.push({
          role: "assistant",
          content: response.contentBlocks,
        });
      } else {
        this.history.push({
          role: "assistant",
          content: response.text || "[No response]",
        });
      }

      break;
    }

    // Check if we hit the iteration limit
    if (!finalResponse) {
      truncated = true;

      // Force a final response without tools
      if (this.config.onThinking) {
        this.config.onThinking("Generating final response...");
      }

      const finalRequest = this.buildRequest(false); // no tools
      apiCallCount++;

      try {
        finalResponse = await this.config.provider.chatWithRetry(
          finalRequest,
          1,
        );

        const apiDurationMs2 = Date.now() - startMs;

        if (finalResponse.ok) {
          session.recordAPISuccess(
            this.config.provider.getProviderId(),
            this.config.model,
            apiDurationMs2,
            finalResponse.usage.totalTokens,
          );

          totalUsage = addUsage(totalUsage, finalResponse.usage);

          this.history.push({
            role: "assistant",
            content:
              finalResponse.contentBlocks.length > 0
                ? finalResponse.contentBlocks
                : finalResponse.text || "[Max iterations reached]",
          });
        }
      } catch {
        // Can't get final response — use what we have
        finalResponse = {
          ok: true,
          text: "[Analysis reached maximum tool call iterations. Please refine your query.]",
          contentBlocks: [
            {
              type: "text",
              text: "[Analysis reached maximum tool call iterations. Please refine your query.]",
            },
          ],
          toolCalls: [],
          stopReason: "end_turn",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: this.config.model,
          durationMs: 0,
        };
      }
    }

    // ── Record the conversation turn ────────────────────────────────

    const turn: ConversationTurn = {
      userMessage,
      agentResponse: finalResponse?.text ?? "",
      toolCalls: executedToolCalls,
      timestamp: new Date().toISOString(),
      usage: totalUsage,
    };
    this.turns.push(turn);

    // ── Build the final result ──────────────────────────────────────

    return {
      ok: finalResponse?.ok ?? false,
      text: finalResponse?.text ?? "",
      contentBlocks: finalResponse?.contentBlocks ?? [],
      toolCallsExecuted: executedToolCalls,
      totalUsage,
      durationMs: Date.now() - startMs,
      apiCallCount,
      toolCallCount: executedToolCalls.length,
      model: finalResponse?.model ?? this.config.model,
      truncated,
      error: finalResponse?.ok ? undefined : finalResponse?.error,
    };
  }

  /**
   * Process a message with streaming, yielding deltas as they arrive.
   *
   * This is a convenience wrapper around processMessage that collects
   * streamed text and returns the final AgentResponse.
   *
   * @param userMessage - The user's input message.
   * @param onDelta     - Callback invoked for each streamed token.
   * @param fileContext  - Optional file context.
   */
  async processMessageStreaming(
    userMessage: string,
    onDelta: (text: string) => void,
    fileContext?: string,
  ): Promise<AgentResponse> {
    const originalOnDelta = this.config.onStreamDelta;
    const originalStreaming = this.config.streaming;

    // Temporarily configure streaming
    this.config.streaming = true;
    this.config.onStreamDelta = (delta: StreamDelta) => {
      if (delta.text) {
        onDelta(delta.text);
      }
    };

    try {
      return await this.processMessage(userMessage, fileContext);
    } finally {
      // Restore original settings
      this.config.streaming = originalStreaming;
      this.config.onStreamDelta = originalOnDelta;
    }
  }

  /**
   * Get the current conversation history.
   */
  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  /**
   * Get the completed conversation turns.
   */
  getTurns(): ConversationTurn[] {
    return [...this.turns];
  }

  /**
   * Clear all conversation history and turns.
   */
  clearHistory(): void {
    this.history = [];
    this.turns = [];
  }

  /**
   * Get the number of messages in the conversation history.
   */
  getHistoryLength(): number {
    return this.history.length;
  }

  /**
   * Get total token usage across all turns.
   */
  getTotalUsage(): TokenUsage {
    let total: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    for (const turn of this.turns) {
      total = addUsage(total, turn.usage);
    }
    return total;
  }

  /**
   * Update the project context in the system prompt.
   * Useful when the scan result changes.
   */
  updateProjectContext(context: string): void {
    this.config.projectContext = context;
    this.systemPrompt = this.buildSystemPrompt();
  }

  /**
   * Update the model (e.g. when user changes model via /conf).
   */
  updateModel(model: string): void {
    this.config.model = model;
  }

  /**
   * Update the provider (e.g. when user changes provider via /conf).
   */
  updateProvider(provider: BaseProvider): void {
    this.config.provider = provider;
  }

  /**
   * Add a system-level context message to the conversation.
   * This is added as a user message with a [SYSTEM] prefix.
   */
  addSystemContext(context: string): void {
    this.history.push({
      role: "user",
      content: `[SYSTEM CONTEXT — do not repeat this to the user]\n${context}`,
    });
  }

  // ── Internal: Request Building ────────────────────────────────────

  /**
   * Build a ChatCompletionRequest from the current state.
   *
   * @param includeTools - Whether to include tool definitions (default: true).
   */
  private buildRequest(includeTools: boolean = true): ChatCompletionRequest {
    const request: ChatCompletionRequest = {
      model: this.config.model,
      messages: [...this.history],
      systemPrompt: this.systemPrompt,
      maxTokens: this.config.maxTokens ?? 8192,
    };

    if (this.config.temperature !== undefined) {
      request.temperature = this.config.temperature;
    }

    if (includeTools && this.toolDefinitions.length > 0) {
      request.tools = this.toolDefinitions;
    }

    return request;
  }

  /**
   * Build the full system prompt from parts.
   */
  private buildSystemPrompt(): string {
    const parts: string[] = [SYSTEM_PROMPT_PREFIX];

    // Add project context if available
    if (this.config.projectContext) {
      parts.push("");
      parts.push("=== PROJECT CONTEXT ===");
      parts.push(this.config.projectContext);
      parts.push("=== END PROJECT CONTEXT ===");
    }

    // Add available tools summary
    parts.push("");
    parts.push("You have access to the following tools:");
    parts.push("- browse_dir: List directory contents");
    parts.push("- browse_file: Read file contents (full or line range)");
    parts.push("- find_file_or_folder: Search for files by pattern");
    if (this.config.mcpEnabled) {
      parts.push("- search_online: Web search via MCP");
      parts.push("- call_mcp: Call MCP servers for documentation lookups");
    }
    parts.push("");
    parts.push(
      "Use these tools to explore the codebase and gather context before making assessments. " +
        "Always examine relevant files before reporting findings.",
    );

    // Add custom suffix
    if (this.config.systemPromptSuffix) {
      parts.push("");
      parts.push(this.config.systemPromptSuffix);
    }

    return parts.join("\n");
  }

  // ── Internal: Tool Execution ──────────────────────────────────────

  /**
   * Execute a single tool call and return the result.
   */
  private async executeToolCall(toolCall: ToolCall): Promise<ExecutedToolCall> {
    const { id, name, input } = toolCall;
    const startMs = Date.now();

    // Notify callback
    if (this.config.onToolCallStart) {
      this.config.onToolCallStart(name, input);
    }

    let result: ToolExecutionResult;

    try {
      if (isBuiltinTool(name)) {
        // Execute built-in tool
        result = await executeBuiltinTool(name, input, this.toolContext);
      } else if (this.config.customToolExecutor) {
        // Execute custom tool
        result = await this.config.customToolExecutor(
          name,
          input,
          this.toolContext,
        );
      } else {
        // Unknown tool
        result = {
          success: false,
          content: "",
          error: `Unknown tool: "${name}". Available tools: ${this.toolDefinitions.map((t) => t.name).join(", ")}`,
          durationMs: 0,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        success: false,
        content: "",
        error: `Tool "${name}" threw an error: ${message}`,
        durationMs: Date.now() - startMs,
      };
    }

    const durationMs = Date.now() - startMs;

    // Notify callback
    if (this.config.onToolCallEnd) {
      this.config.onToolCallEnd(name, result, durationMs);
    }

    // Audit log
    await appendAuditLog(
      `Tool call: ${name} — ${result.success ? "success" : "failed"} (${durationMs}ms)`,
      "agent",
    );

    // Build the output content for the model
    let output: string;
    if (result.success) {
      output = result.content;
    } else {
      output = `Error: ${result.error ?? "Unknown error"}`;
      if (result.content) {
        output += `\n\nPartial output:\n${result.content}`;
      }
    }

    // Truncate very large tool outputs to avoid context overflow
    const MAX_TOOL_OUTPUT = 100_000;
    if (output.length > MAX_TOOL_OUTPUT) {
      output =
        output.slice(0, MAX_TOOL_OUTPUT) +
        `\n\n... [Output truncated at ${MAX_TOOL_OUTPUT} characters]`;
    }

    return {
      id,
      name,
      input,
      success: result.success,
      output,
      durationMs,
      error: result.error,
    };
  }

  // ── Internal: History Management ──────────────────────────────────

  /**
   * Summarize older conversation history to keep context manageable.
   *
   * Replaces older turns with a condensed summary message, preserving
   * the most recent turns for continuity.
   */
  private async summarizeHistory(): Promise<void> {
    const keepRecent = 10; // Keep the last N messages

    if (this.history.length <= keepRecent * 2) {
      return; // Not enough history to summarize
    }

    // Build a summary of older turns
    const olderTurns = this.turns.slice(0, -keepRecent);
    if (olderTurns.length === 0) return;

    const summaryParts: string[] = [
      "[Conversation Summary — older messages condensed]",
      "",
    ];

    for (const turn of olderTurns) {
      summaryParts.push(`User: ${truncateText(turn.userMessage, 200)}`);
      summaryParts.push(`Agent: ${truncateText(turn.agentResponse, 300)}`);
      if (turn.toolCalls.length > 0) {
        summaryParts.push(
          `  Tools used: ${turn.toolCalls.map((tc) => tc.name).join(", ")}`,
        );
      }
      summaryParts.push("");
    }

    const summaryText = summaryParts.join("\n");

    // Replace history: summary + recent messages
    const recentMessages = this.history.slice(-keepRecent);
    this.history = [
      {
        role: "user",
        content: summaryText,
      },
      {
        role: "assistant",
        content:
          "I understand the previous conversation context. I'll continue from here.",
      },
      ...recentMessages,
    ];

    // Trim the turns array too
    this.turns = this.turns.slice(-keepRecent);
  }
}

// ── Helper Functions ────────────────────────────────────────────────────────

/**
 * Add two TokenUsage objects together.
 */
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedTokens: (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0) || undefined,
  };
}

/**
 * Truncate text to a maximum length, adding ellipsis if needed.
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a new Agent instance with the given configuration.
 *
 * This is the preferred way to create an agent — it validates the config
 * and returns a ready-to-use Agent.
 *
 * @param config - Agent configuration.
 * @returns A new Agent instance.
 */
export function createAgent(config: AgentConfig): Agent {
  if (!config.provider) {
    throw new Error("Agent requires a provider instance.");
  }

  if (!config.model) {
    throw new Error("Agent requires a model ID.");
  }

  if (!config.projectRoot) {
    throw new Error("Agent requires a project root path.");
  }

  return new Agent(config);
}

/**
 * Parse @ file/folder mentions from user input.
 *
 * Extracts paths prefixed with @ and returns them separately from
 * the remaining message text.
 *
 * Examples:
 *   "Analyze @src/auth.ts for XSS"
 *     → { message: "Analyze  for XSS", targets: ["src/auth.ts"] }
 *
 *   "@src/components/ check for secrets"
 *     → { message: " check for secrets", targets: ["src/components/"] }
 *
 * @param input - Raw user input.
 * @returns Parsed message and extracted file/folder targets.
 */
export function parseTargetMentions(input: string): {
  message: string;
  targets: string[];
} {
  const targets: string[] = [];
  const mentionRegex = /@([^\s]+)/g;

  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(input)) !== null) {
    const target = match[1];
    if (target) {
      targets.push(target);
    }
  }

  // Remove the mentions from the message
  const message = input.replace(mentionRegex, "").replace(/\s+/g, " ").trim();

  return { message, targets };
}

/**
 * Build file context from @ mention targets.
 *
 * Reads the targeted files/directories and produces a context string
 * suitable for including in the agent's user message.
 *
 * @param targets     - File/folder paths from parseTargetMentions.
 * @param projectRoot - The project root path.
 * @returns A context string with file contents, or empty string if no targets.
 */
export async function buildTargetContext(
  targets: string[],
  projectRoot: string,
): Promise<string> {
  if (targets.length === 0) return "";

  const { scanSingleFile, scanProject } = await import("../scanner/index.js");
  const { buildFileContext } = await import("../scanner/index.js");

  const parts: string[] = [];
  parts.push("=== TARGETED FILES ===");
  parts.push("");

  for (const target of targets) {
    try {
      const { resolve: resolvePath } = await import("node:path");
      const absPath = resolvePath(projectRoot, target);

      const { isDirectory: isDirFn, exists: existsFn } =
        await import("../utils/fs.js");

      const targetExists = await existsFn(absPath);
      if (!targetExists) {
        parts.push(`[File not found: ${target}]`);
        parts.push("");
        continue;
      }

      const isDir = await isDirFn(absPath);

      if (isDir) {
        // Scan the directory
        const scanResult = await scanProject(absPath, {
          maxFiles: 50,
          maxDepth: 5,
          includeContent: true,
        });

        const context = buildFileContext(scanResult.files, 200_000);
        parts.push(context);
      } else {
        // Read single file
        const file = await scanSingleFile(absPath, projectRoot);
        if (file && file.readOk) {
          parts.push(
            `=== FILE: ${file.relativePath} (${file.lineCount} lines) ===`,
          );
          parts.push(file.content);
          parts.push(`=== END FILE ===`);
          parts.push("");
        } else {
          parts.push(`[Could not read: ${target}]`);
          parts.push("");
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      parts.push(`[Error reading ${target}: ${message}]`);
      parts.push("");
    }
  }

  parts.push("=== END TARGETED FILES ===");

  return parts.join("\n");
}
