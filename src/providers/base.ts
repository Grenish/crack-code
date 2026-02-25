// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Base AI Provider Interface & Abstract Contracts
// ─────────────────────────────────────────────────────────────────────────────
// Defines the provider-agnostic contracts that every AI backend must
// implement. The system never couples to a specific vendor — all
// communication flows through these interfaces.
// ─────────────────────────────────────────────────────────────────────────────

import type { AIProvider } from "../utils/constants.js";
import type { DiscoveredModel, ModelFetchResult } from "./model-fetcher.js";

// ── Message Types ───────────────────────────────────────────────────────────

/** Role of a participant in a conversation */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** A single text content block */
export interface TextContent {
  type: "text";
  text: string;
}

/** A tool-use request emitted by the assistant */
export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A tool result returned to the model after execution */
export interface ToolResultContent {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** Union of all content block types */
export type ContentBlock = TextContent | ToolUseContent | ToolResultContent;

/** A single message in a conversation */
export interface ChatMessage {
  role: MessageRole;
  content: string | ContentBlock[];
  /** For tool-result messages, the tool_use id this result corresponds to */
  toolUseId?: string;
  /** Optional name tag (used for tool results in some APIs) */
  name?: string;
}

// ── Tool / Function Definitions ─────────────────────────────────────────────

/** JSON Schema for a tool parameter */
export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParameterProperty;
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
  default?: unknown;
}

/** Schema describing a tool's input parameters (JSON Schema object) */
export interface ToolParametersSchema {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/** A tool (function) definition sent to the AI model */
export interface ToolDefinition {
  /** Unique name of the tool */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** JSON Schema describing the tool's input parameters */
  parameters: ToolParametersSchema;
}

// ── Completion Request & Response ───────────────────────────────────────────

/** Configuration for a chat completion request */
export interface ChatCompletionRequest {
  /** The model identifier to use (e.g. "claude-sonnet-4-20250514") */
  model: string;
  /** The conversation messages */
  messages: ChatMessage[];
  /** System prompt (some providers accept it separately) */
  systemPrompt?: string;
  /** Tool definitions available to the model */
  tools?: ToolDefinition[];
  /** Sampling temperature (0.0–2.0, default provider-dependent) */
  temperature?: number;
  /** Maximum tokens to generate in the response */
  maxTokens?: number;
  /** Top-p nucleus sampling (0.0–1.0) */
  topP?: number;
  /** Stop sequences that halt generation */
  stopSequences?: string[];
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/** Reason the model stopped generating */
export type StopReason =
  | "end_turn"
  | "stop_sequence"
  | "max_tokens"
  | "tool_use"
  | "error"
  | "unknown";

/** A parsed tool call from the model's response */
export interface ToolCall {
  /** Unique ID for this tool call (used to match tool results) */
  id: string;
  /** Name of the tool the model wants to invoke */
  name: string;
  /** Parsed input arguments */
  input: Record<string, unknown>;
}

/** Token usage statistics for a single request */
export interface TokenUsage {
  /** Number of tokens in the prompt / input */
  promptTokens: number;
  /** Number of tokens in the completion / output */
  completionTokens: number;
  /** Total tokens (prompt + completion) */
  totalTokens: number;
  /** Cached tokens read (if provider reports it) */
  cachedTokens?: number;
}

/** Response from a chat completion request */
export interface ChatCompletionResponse {
  /** Whether the request succeeded */
  ok: boolean;
  /** The full text content of the assistant's reply (may be empty if tool_use) */
  text: string;
  /** Parsed content blocks (text and/or tool_use) */
  contentBlocks: ContentBlock[];
  /** Tool calls requested by the model (extracted from contentBlocks) */
  toolCalls: ToolCall[];
  /** Why the model stopped generating */
  stopReason: StopReason;
  /** Token usage statistics */
  usage: TokenUsage;
  /** The model ID that actually served the request */
  model: string;
  /** Error message if the request failed */
  error?: string;
  /** HTTP status code (if applicable) */
  statusCode?: number;
  /** Duration of the API call in milliseconds */
  durationMs: number;
  /** Raw response body for debugging */
  raw?: unknown;
}

// ── Streaming Types ─────────────────────────────────────────────────────────

/** A delta event emitted during streaming */
export interface StreamDelta {
  /** Incremental text content */
  text?: string;
  /** A tool use block that is being built up incrementally */
  toolUse?: {
    id: string;
    name?: string;
    inputDelta?: string;
  };
  /** The stop reason when the stream ends */
  stopReason?: StopReason;
  /** Token usage (typically only present in the final event) */
  usage?: TokenUsage;
}

/** Callback invoked for each streaming delta */
export type StreamCallback = (delta: StreamDelta) => void;

/** Request that enables streaming */
export interface StreamingChatCompletionRequest extends ChatCompletionRequest {
  /** Callback invoked for each streamed token/event */
  onDelta: StreamCallback;
}

// ── Provider Health & Metadata ──────────────────────────────────────────────

/** Health check result for a provider */
export interface ProviderHealthCheck {
  /** Whether the provider is reachable and the credentials are valid */
  healthy: boolean;
  /** Latency of the health check in milliseconds */
  latencyMs: number;
  /** Error message if unhealthy */
  error?: string;
  /** Number of available models */
  modelCount: number;
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
}

/** Static metadata about a provider */
export interface ProviderInfo {
  /** Provider identifier */
  id: AIProvider;
  /** Human-readable provider name */
  label: string;
  /** Base URL for API requests */
  baseUrl: string;
  /** Whether this provider runs locally (e.g. Ollama) */
  isLocal: boolean;
  /** Whether this provider supports streaming */
  supportsStreaming: boolean;
  /** Whether this provider supports tool/function calling */
  supportsToolCalling: boolean;
  /** Whether this provider supports vision/image inputs */
  supportsVision: boolean;
  /** Maximum context window size (tokens) — for the largest model */
  maxContextTokens: number;
  /** The environment variable name for the API key */
  envKeyName: string;
}

// ── Abstract Base Provider ──────────────────────────────────────────────────

/**
 * Abstract base class for all AI providers.
 *
 * Each concrete provider (Anthropic, OpenAI, Gemini, etc.) extends this
 * class and implements the abstract methods to translate between our
 * unified message format and the vendor-specific API.
 *
 * The base class provides:
 * - Credential management (API key / endpoint storage)
 * - Model caching and listing
 * - Retry logic with exponential backoff
 * - Request/response logging hooks
 * - Common validation
 */
export abstract class BaseProvider {
  // ── Instance State ──────────────────────────────────────────────────

  /** The API key (or empty string for keyless providers) */
  protected apiKey: string;

  /** The base URL for API requests (can be overridden per-provider) */
  protected baseUrl: string;

  /** The currently selected default model ID */
  protected selectedModel: string = "";

  /** Cached list of discovered models (populated by listModels) */
  protected cachedModels: DiscoveredModel[] = [];

  /** Whether the provider has been initialized and validated */
  protected initialized: boolean = false;

  // ── Constructor ─────────────────────────────────────────────────────

  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  // ── Abstract Methods (must be implemented by each provider) ────────

  /**
   * Return static metadata about this provider.
   */
  abstract getInfo(): ProviderInfo;

  /**
   * Send a chat completion request and return a structured response.
   * This is the core method every provider must implement.
   *
   * The implementation must:
   * 1. Transform ChatMessage[] into the provider's native format.
   * 2. Include tool definitions if provided.
   * 3. Execute the HTTP request to the provider's API.
   * 4. Parse the response into a ChatCompletionResponse.
   * 5. Extract any tool calls from the response.
   */
  abstract chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;

  /**
   * Send a streaming chat completion request.
   * Implementations should call `request.onDelta()` for each event.
   * Returns the final accumulated response.
   *
   * If the provider doesn't support streaming, this may fall back
   * to a non-streaming call and emit a single delta.
   */
  abstract chatStream(
    request: StreamingChatCompletionRequest
  ): Promise<ChatCompletionResponse>;

  /**
   * Fetch available models from the provider's API.
   * Implementations should use the model-fetcher module.
   */
  abstract listModels(): Promise<ModelFetchResult>;

  /**
   * Perform a health check — validate the API key and connectivity.
   */
  abstract healthCheck(): Promise<ProviderHealthCheck>;

  // ── Concrete Methods (shared across all providers) ─────────────────

  /**
   * Get the provider identifier.
   */
  getProviderId(): AIProvider {
    return this.getInfo().id;
  }

  /**
   * Get the human-readable provider label.
   */
  getProviderLabel(): string {
    return this.getInfo().label;
  }

  /**
   * Get the currently selected model ID.
   */
  getSelectedModel(): string {
    return this.selectedModel;
  }

  /**
   * Set the selected model ID.
   */
  setSelectedModel(modelId: string): void {
    this.selectedModel = modelId;
  }

  /**
   * Get the API key (masked for display — shows first 4 and last 4 chars).
   */
  getMaskedApiKey(): string {
    if (!this.apiKey) return "(none)";
    if (this.apiKey.length <= 12) return "****";
    return `${this.apiKey.slice(0, 4)}${"*".repeat(Math.min(this.apiKey.length - 8, 20))}${this.apiKey.slice(-4)}`;
  }

  /**
   * Get the raw API key (for making requests — never display this).
   */
  getApiKey(): string {
    return this.apiKey;
  }

  /**
   * Update the API key.
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    this.initialized = false;
    this.cachedModels = [];
  }

  /**
   * Get the base URL.
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Update the base URL.
   */
  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
    this.initialized = false;
    this.cachedModels = [];
  }

  /**
   * Whether this provider has been successfully initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get cached models (call listModels() first to populate).
   */
  getCachedModels(): DiscoveredModel[] {
    return [...this.cachedModels];
  }

  /**
   * Get cached models that support tool calling.
   */
  getToolCallingModels(): DiscoveredModel[] {
    return this.cachedModels.filter((m) => m.supportsToolCalling);
  }

  /**
   * Initialize the provider: validate credentials and fetch models.
   * Marks the provider as initialized on success.
   *
   * @returns true if initialization succeeded.
   */
  async initialize(): Promise<{ ok: boolean; error?: string }> {
    try {
      const health = await this.healthCheck();
      if (!health.healthy) {
        return { ok: false, error: health.error ?? "Health check failed" };
      }

      const models = await this.listModels();
      if (models.ok) {
        this.cachedModels = models.toolCallingModels.length > 0
          ? models.toolCallingModels
          : models.allModels;
      }

      this.initialized = true;
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /**
   * Validate that a model ID exists in the cached model list.
   */
  isValidModel(modelId: string): boolean {
    if (this.cachedModels.length === 0) return true; // Can't validate without cache
    return this.cachedModels.some((m) => m.id === modelId);
  }

  /**
   * Execute a chat completion with automatic retry on transient failures.
   *
   * @param request - The chat completion request.
   * @param maxRetries - Maximum number of retry attempts (default 2).
   * @param baseDelayMs - Base delay between retries in ms (default 1000).
   * @returns The chat completion response.
   */
  async chatWithRetry(
    request: ChatCompletionRequest,
    maxRetries: number = 2,
    baseDelayMs: number = 1000
  ): Promise<ChatCompletionResponse> {
    let lastResponse: ChatCompletionResponse | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await this.chat(request);

      // Success or non-retryable error — return immediately
      if (response.ok) return response;

      lastResponse = response;

      // Don't retry client errors (4xx) except 429 (rate limit)
      const status = response.statusCode ?? 0;
      if (status >= 400 && status < 500 && status !== 429) {
        return response;
      }

      // Don't retry on the last attempt
      if (attempt >= maxRetries) break;

      // Exponential backoff with jitter
      const delay = baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.random() * delay * 0.3;
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }

    return lastResponse!;
  }

  // ── Utility Methods ─────────────────────────────────────────────────

  /**
   * Build an error ChatCompletionResponse.
   * Convenience for provider implementations.
   */
  protected buildErrorResponse(
    error: string,
    statusCode?: number,
    durationMs: number = 0
  ): ChatCompletionResponse {
    return {
      ok: false,
      text: "",
      contentBlocks: [],
      toolCalls: [],
      stopReason: "error",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: this.selectedModel,
      error,
      statusCode,
      durationMs,
    };
  }

  /**
   * Extract the plain text from an array of content blocks.
   */
  protected extractText(blocks: ContentBlock[]): string {
    return blocks
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  /**
   * Extract tool calls from an array of content blocks.
   */
  protected extractToolCalls(blocks: ContentBlock[]): ToolCall[] {
    return blocks
      .filter((b): b is ToolUseContent => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        name: b.name,
        input: b.input,
      }));
  }

  /**
   * Determine the stop reason from tool calls and provider hints.
   */
  protected determineStopReason(
    toolCalls: ToolCall[],
    providerReason?: string
  ): StopReason {
    if (toolCalls.length > 0) return "tool_use";

    switch (providerReason?.toLowerCase()) {
      case "end_turn":
      case "stop":
      case "eos":
      case "complete":
      case "normal":
        return "end_turn";
      case "length":
      case "max_tokens":
        return "max_tokens";
      case "stop_sequence":
        return "stop_sequence";
      case "tool_use":
      case "tool_calls":
      case "function_call":
        return "tool_use";
      default:
        return providerReason ? "unknown" : "end_turn";
    }
  }

  /**
   * Generate a unique tool-use ID. Used when the provider doesn't
   * assign its own IDs.
   */
  protected generateToolUseId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 8);
    return `toolu_${timestamp}${random}`;
  }

  /**
   * Flatten messages so that the content field is always a string
   * (for providers that don't support content blocks natively).
   */
  protected flattenMessageContent(msg: ChatMessage): string {
    if (typeof msg.content === "string") return msg.content;

    return msg.content
      .map((block) => {
        switch (block.type) {
          case "text":
            return block.text;
          case "tool_use":
            return `[Tool Call: ${block.name}(${JSON.stringify(block.input)})]`;
          case "tool_result":
            return block.content;
          default:
            return "";
        }
      })
      .join("\n");
  }
}

// ── Provider Factory Type ───────────────────────────────────────────────────

/**
 * Factory function signature for creating a provider instance.
 * Used by the provider registry.
 */
export type ProviderFactory = (apiKey: string, baseUrl: string) => BaseProvider;
