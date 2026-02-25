// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — OpenAI-Compatible Base Provider
// ─────────────────────────────────────────────────────────────────────────────
// Shared implementation for all providers that follow the OpenAI Chat
// Completions API format. This includes: OpenAI, xAI (Grok), Alibaba
// Qwen (DashScope compatible mode), and Moonshot (Kimi).
//
// Each concrete provider extends this class and only overrides metadata
// (getInfo, listModels) — the actual HTTP request/response handling is
// identical across all OpenAI-compatible APIs.
//
// Zero external dependencies — uses the built-in fetch API exclusively.
// ─────────────────────────────────────────────────────────────────────────────

import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type StreamingChatCompletionRequest,
  type ChatMessage,
  type ContentBlock,
  type TextContent,
  type ToolUseContent,
  type ToolCall,
  type ToolDefinition,
  type TokenUsage,
  type StopReason,
  type StreamDelta,
  type ProviderInfo,
  type ProviderHealthCheck,
} from "./base.js";

import { fetchModels, type ModelFetchResult } from "./model-fetcher.js";

import { type AIProvider, HTTP_TIMEOUT_MS } from "../utils/constants.js";

// ── OpenAI API Types ────────────────────────────────────────────────────────

/** A single message in the OpenAI Chat Completions format */
interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Tool calls requested by the assistant (only on assistant messages) */
  tool_calls?: OAIToolCall[];
  /** Tool call ID this message is responding to (only on tool messages) */
  tool_call_id?: string;
  /** Optional name for the message sender */
  name?: string;
}

/** A tool call in the OpenAI response format */
interface OAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Tool (function) definition in OpenAI format */
interface OAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

/** Request body for the OpenAI Chat Completions API */
interface OAIChatRequest {
  model: string;
  messages: OAIMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string[];
  tools?: OAIToolDef[];
  stream?: boolean;
  /** Stream options — request usage stats in the final chunk */
  stream_options?: { include_usage: boolean };
}

/** A single choice in the response */
interface OAIChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OAIToolCall[];
  };
  finish_reason: string | null;
}

/** Usage stats from the response */
interface OAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

/** Full response from the Chat Completions API */
interface OAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OAIChoice[];
  usage?: OAIUsage;
}

/** Error response from the API */
interface OAIErrorResponse {
  error?: {
    message: string;
    type: string;
    code?: string | number;
    param?: string | null;
  };
  message?: string;
  detail?: string;
}

// ── Streaming Types ─────────────────────────────────────────────────────────

/** A streaming delta chunk */
interface OAIStreamChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: "function";
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason: string | null;
}

/** A streaming chunk from the API */
interface OAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OAIStreamChoice[];
  usage?: OAIUsage | null;
}

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 8192;

// ── OpenAI-Compatible Provider Base ─────────────────────────────────────────

/**
 * Abstract base for all providers that implement the OpenAI Chat Completions
 * API contract. Subclasses override `getInfo()` and `listModels()` to provide
 * provider-specific metadata and model discovery — everything else is shared.
 *
 * Supports:
 * - Chat completions with tool/function calling
 * - SSE streaming with incremental tool call assembly
 * - Dynamic model discovery via the model-fetcher module
 * - Health checks via model listing
 * - Automatic role merging and message normalization
 */
export abstract class OpenAICompatibleProvider extends BaseProvider {
  /** The provider's AI_PROVIDER enum value — set by subclasses */
  protected abstract readonly providerId: AIProvider;

  constructor(apiKey: string, baseUrl: string) {
    super(apiKey, baseUrl);
  }

  // ── Abstract (provider-specific) ────────────────────────────────────

  abstract override getInfo(): ProviderInfo;

  // ── Model Discovery ─────────────────────────────────────────────────

  override async listModels(): Promise<ModelFetchResult> {
    return fetchModels(this.providerId, this.apiKey, this.baseUrl);
  }

  // ── Health Check ────────────────────────────────────────────────────

  override async healthCheck(): Promise<ProviderHealthCheck> {
    const start = performance.now();

    try {
      const result = await this.listModels();
      const latencyMs = performance.now() - start;

      if (!result.ok) {
        return {
          healthy: false,
          latencyMs,
          error: result.error,
          modelCount: 0,
        };
      }

      return {
        healthy: true,
        latencyMs,
        modelCount: result.allModels.length,
        metadata: {
          toolCallingModels: result.toolCallingModels.length,
        },
      };
    } catch (err) {
      const latencyMs = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      return {
        healthy: false,
        latencyMs,
        error: `Connection failed: ${message}`,
        modelCount: 0,
      };
    }
  }

  // ── Chat Completion ─────────────────────────────────────────────────

  override async chat(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const start = performance.now();

    try {
      const body = this.buildRequestBody(request, false);
      const url = this.getChatEndpoint();

      const response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: request.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });

      const durationMs = performance.now() - start;

      if (!response.ok) {
        return this.handleErrorResponse(response, durationMs);
      }

      const data = (await response.json()) as OAIChatResponse;
      return this.parseResponse(data, durationMs);
    } catch (err) {
      return this.handleFetchError(err, start);
    }
  }

  // ── Streaming Chat Completion ───────────────────────────────────────

  override async chatStream(
    request: StreamingChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const start = performance.now();

    try {
      const body = this.buildRequestBody(request, true);
      const url = this.getChatEndpoint();

      const response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: request.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS * 3),
      });

      const durationMs = performance.now() - start;

      if (!response.ok) {
        return this.handleErrorResponse(response, durationMs);
      }

      if (!response.body) {
        return this.buildErrorResponse(
          "No response body for streaming",
          undefined,
          durationMs,
        );
      }

      return await this.processStream(response.body, request.onDelta, start);
    } catch (err) {
      return this.handleFetchError(err, start);
    }
  }

  // ── Endpoint Configuration ──────────────────────────────────────────

  /**
   * Get the full URL for the chat completions endpoint.
   * Override in subclasses if the path differs from `/v1/chat/completions`.
   */
  protected getChatEndpoint(): string {
    return `${this.baseUrl}/v1/chat/completions`;
  }

  // ── Request Building ────────────────────────────────────────────────

  /**
   * Build the HTTP headers for API requests.
   * Override in subclasses to add provider-specific headers.
   */
  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  /**
   * Transform our unified ChatCompletionRequest into the OpenAI Chat
   * Completions API request body format.
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
    stream: boolean,
  ): OAIChatRequest {
    const model = request.model || this.selectedModel;
    if (!model) {
      throw new Error(
        "No model specified. Set a model via configuration or pass it in the request.",
      );
    }

    const messages = this.transformMessages(
      request.messages,
      request.systemPrompt,
    );

    const body: OAIChatRequest = {
      model,
      messages,
    };

    // Max tokens
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    } else {
      body.max_tokens = DEFAULT_MAX_TOKENS;
    }

    // Sampling parameters
    if (request.temperature !== undefined) {
      body.temperature = Math.max(0, Math.min(2, request.temperature));
    }

    if (request.topP !== undefined) {
      body.top_p = Math.max(0, Math.min(1, request.topP));
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      body.stop = request.stopSequences;
    }

    // Tool definitions
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) =>
        this.transformToolDefinition(tool),
      );
    }

    // Streaming
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }

    return body;
  }

  /**
   * Transform our unified ChatMessage[] into the OpenAI message format.
   *
   * OpenAI's format is more straightforward than Anthropic's:
   * - System messages go directly in the messages array
   * - Tool results are sent as role:"tool" messages with tool_call_id
   * - Assistant tool calls use the tool_calls field
   */
  private transformMessages(
    messages: ChatMessage[],
    systemPrompt?: string,
  ): OAIMessage[] {
    const result: OAIMessage[] = [];

    // Prepend system prompt if provided and not already in messages
    if (systemPrompt) {
      const hasSystemMsg = messages.some((m) => m.role === "system");
      if (!hasSystemMsg) {
        result.push({
          role: "system",
          content: systemPrompt,
        });
      }
    }

    for (const msg of messages) {
      switch (msg.role) {
        case "system": {
          result.push({
            role: "system",
            content: this.getTextContent(msg),
          });
          break;
        }

        case "user": {
          result.push({
            role: "user",
            content: this.getTextContent(msg),
          });
          break;
        }

        case "assistant": {
          if (typeof msg.content === "string") {
            result.push({
              role: "assistant",
              content: msg.content,
            });
          } else {
            // Parse content blocks — separate text and tool_use blocks
            const textParts: string[] = [];
            const toolCalls: OAIToolCall[] = [];

            for (const block of msg.content) {
              if (block.type === "text") {
                textParts.push(block.text);
              } else if (block.type === "tool_use") {
                toolCalls.push({
                  id: block.id,
                  type: "function",
                  function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                  },
                });
              }
            }

            const oaiMsg: OAIMessage = {
              role: "assistant",
              content: textParts.length > 0 ? textParts.join("") : null,
            };

            if (toolCalls.length > 0) {
              oaiMsg.tool_calls = toolCalls;
            }

            result.push(oaiMsg);
          }
          break;
        }

        case "tool": {
          // Tool result messages
          const content = this.getTextContent(msg);
          result.push({
            role: "tool",
            content,
            tool_call_id: msg.toolUseId ?? msg.name ?? "",
            name: msg.name,
          });
          break;
        }
      }
    }

    return result;
  }

  /**
   * Extract text content from a ChatMessage, handling both string and
   * content-block formats.
   */
  private getTextContent(msg: ChatMessage): string {
    if (typeof msg.content === "string") return msg.content;

    return msg.content
      .filter(
        (
          b,
        ): b is
          | TextContent
          | { type: "tool_result"; content: string; toolUseId: string } =>
          b.type === "text" || b.type === "tool_result",
      )
      .map((b) => {
        if (b.type === "text") return b.text;
        if ("content" in b) return b.content;
        return "";
      })
      .join("");
  }

  /**
   * Transform our unified ToolDefinition into OpenAI's function tool format.
   */
  private transformToolDefinition(tool: ToolDefinition): OAIToolDef {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: tool.parameters.properties as Record<string, unknown>,
          required: tool.parameters.required,
          additionalProperties: tool.parameters.additionalProperties,
        },
      },
    };
  }

  // ── Response Parsing ────────────────────────────────────────────────

  /**
   * Parse an OpenAI Chat Completions response into our unified format.
   */
  private parseResponse(
    data: OAIChatResponse,
    durationMs: number,
  ): ChatCompletionResponse {
    const choice = data.choices[0];

    if (!choice) {
      return this.buildErrorResponse(
        "No choices returned in the response",
        undefined,
        durationMs,
      );
    }

    const contentBlocks: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];

    // Text content
    if (choice.message.content) {
      const textBlock: TextContent = {
        type: "text",
        text: choice.message.content,
      };
      contentBlocks.push(textBlock);
    }

    // Tool calls
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          input = { _raw: tc.function.arguments };
        }

        const toolUseBlock: ToolUseContent = {
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        };
        contentBlocks.push(toolUseBlock);

        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
    }

    const text = this.extractText(contentBlocks);
    const stopReason = this.mapFinishReason(choice.finish_reason);

    const usage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
      cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
    };

    return {
      ok: true,
      text,
      contentBlocks,
      toolCalls,
      stopReason,
      usage,
      model: data.model,
      durationMs,
      raw: data,
    };
  }

  /**
   * Map OpenAI's finish_reason to our unified StopReason.
   */
  private mapFinishReason(reason: string | null): StopReason {
    switch (reason) {
      case "stop":
        return "end_turn";
      case "length":
        return "max_tokens";
      case "tool_calls":
      case "function_call":
        return "tool_use";
      case "content_filter":
        return "end_turn";
      default:
        return reason ? "unknown" : "end_turn";
    }
  }

  // ── Stream Processing ───────────────────────────────────────────────

  /**
   * Process an OpenAI SSE stream, accumulating content and tool calls,
   * and invoking the delta callback for each chunk.
   */
  private async processStream(
    body: ReadableStream<Uint8Array>,
    onDelta: (delta: StreamDelta) => void,
    startTime: number,
  ): Promise<ChatCompletionResponse> {
    const decoder = new TextDecoder();
    const reader = body.getReader();

    // Accumulated state
    let accumulatedText = "";
    let model = this.selectedModel;
    let stopReason: StopReason = "unknown";
    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    // In-progress tool calls indexed by their array position
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; argumentsJson: string }
    >();

    // SSE line buffer
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();

          // Skip empty lines, comments, and event type lines
          if (
            !trimmed ||
            trimmed.startsWith(":") ||
            trimmed.startsWith("event:")
          ) {
            continue;
          }

          // Only process data lines
          if (!trimmed.startsWith("data:")) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          let chunk: OAIStreamChunk;
          try {
            chunk = JSON.parse(jsonStr) as OAIStreamChunk;
          } catch {
            continue; // Skip malformed JSON
          }

          // Update model from chunk
          if (chunk.model) {
            model = chunk.model;
          }

          // Process usage from the final chunk (if stream_options was set)
          if (chunk.usage) {
            usage = {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
              cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
            };
            onDelta({ usage });
          }

          const choice = chunk.choices[0];
          if (!choice) continue;

          // ── Text delta ──────────────────────────────────────────
          if (choice.delta.content) {
            accumulatedText += choice.delta.content;
            onDelta({ text: choice.delta.content });
          }

          // ── Tool call deltas ────────────────────────────────────
          if (choice.delta.tool_calls) {
            for (const tcDelta of choice.delta.tool_calls) {
              const idx = tcDelta.index;

              // New tool call starting
              if (tcDelta.id) {
                pendingToolCalls.set(idx, {
                  id: tcDelta.id,
                  name: tcDelta.function?.name ?? "",
                  argumentsJson: tcDelta.function?.arguments ?? "",
                });

                onDelta({
                  toolUse: {
                    id: tcDelta.id,
                    name: tcDelta.function?.name,
                  },
                });
              } else {
                // Continuation of an existing tool call
                const pending = pendingToolCalls.get(idx);
                if (pending) {
                  if (tcDelta.function?.name) {
                    pending.name = tcDelta.function.name;
                  }
                  if (tcDelta.function?.arguments) {
                    pending.argumentsJson += tcDelta.function.arguments;
                    onDelta({
                      toolUse: {
                        id: pending.id,
                        inputDelta: tcDelta.function.arguments,
                      },
                    });
                  }
                }
              }
            }
          }

          // ── Finish reason ───────────────────────────────────────
          if (choice.finish_reason) {
            stopReason = this.mapFinishReason(choice.finish_reason);
            onDelta({ stopReason });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // ── Finalize accumulated content ──────────────────────────────────

    const contentBlocks: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];

    // Add text content
    if (accumulatedText) {
      const textBlock: TextContent = {
        type: "text",
        text: accumulatedText,
      };
      contentBlocks.push(textBlock);
    }

    // Finalize all pending tool calls
    const sortedEntries = Array.from(pendingToolCalls.entries()).sort(
      ([a], [b]) => a - b,
    );

    for (const [, pending] of sortedEntries) {
      let input: Record<string, unknown> = {};
      try {
        if (pending.argumentsJson) {
          input = JSON.parse(pending.argumentsJson) as Record<string, unknown>;
        }
      } catch {
        input = { _raw: pending.argumentsJson };
      }

      const toolUseBlock: ToolUseContent = {
        type: "tool_use",
        id: pending.id || this.generateToolUseId(),
        name: pending.name,
        input,
      };
      contentBlocks.push(toolUseBlock);

      toolCalls.push({
        id: toolUseBlock.id,
        name: pending.name,
        input,
      });
    }

    // Correct stop reason if we have tool calls
    if (toolCalls.length > 0 && stopReason !== "tool_use") {
      stopReason = "tool_use";
    }

    const durationMs = performance.now() - startTime;

    return {
      ok: true,
      text: accumulatedText,
      contentBlocks,
      toolCalls,
      stopReason,
      usage,
      model,
      durationMs,
    };
  }

  // ── Error Handling ──────────────────────────────────────────────────

  /**
   * Handle a non-OK HTTP response from the API.
   */
  private async handleErrorResponse(
    response: Response,
    durationMs: number,
  ): Promise<ChatCompletionResponse> {
    const errorBody = await response.text().catch(() => "");
    let errorMessage = `HTTP ${response.status} ${response.statusText}`;

    try {
      const parsed = JSON.parse(errorBody) as OAIErrorResponse;
      const msg =
        parsed?.error?.message ??
        parsed?.message ??
        parsed?.detail ??
        errorBody.slice(0, 300);
      if (msg) {
        const type = parsed?.error?.type ?? "";
        errorMessage = type ? `${type}: ${msg}` : msg;
      }
    } catch {
      if (errorBody) {
        errorMessage += `: ${errorBody.slice(0, 300)}`;
      }
    }

    return this.buildErrorResponse(errorMessage, response.status, durationMs);
  }

  /**
   * Handle fetch-level errors (network, timeout, abort).
   */
  private handleFetchError(
    err: unknown,
    startTime: number,
  ): ChatCompletionResponse {
    const durationMs = performance.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    if (
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError")
    ) {
      return this.buildErrorResponse(
        `Request timed out after ${HTTP_TIMEOUT_MS / 1000}s`,
        408,
        durationMs,
      );
    }

    return this.buildErrorResponse(
      `Request failed: ${message}`,
      undefined,
      durationMs,
    );
  }
}
