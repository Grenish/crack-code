// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Anthropic Claude Provider
// ─────────────────────────────────────────────────────────────────────────────
// Concrete implementation of BaseProvider for the Anthropic Messages API.
// Supports chat completions with tool/function calling, streaming, dynamic
// model discovery, and health checks. Zero external dependencies — uses
// the built-in fetch API exclusively.
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
  type ToolResultContent,
  type ToolCall,
  type ToolDefinition,
  type TokenUsage,
  type StopReason,
  type StreamDelta,
  type ProviderInfo,
  type ProviderHealthCheck,
} from "./base.js";

import {
  fetchModels,
  type ModelFetchResult,
} from "./model-fetcher.js";

import {
  AI_PROVIDER,
  AI_PROVIDER_LABELS,
  AI_PROVIDER_ENV_KEYS,
  HTTP_TIMEOUT_MS,
} from "../utils/constants.js";

// ── Anthropic API Types ─────────────────────────────────────────────────────

/**
 * Anthropic Messages API content block types (request-side).
 * These mirror the shapes the API expects in the `messages[].content` array.
 */
interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
  is_error?: boolean;
}

interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicImageBlock;

/** A single message in the Anthropic Messages API format */
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** Tool definition in Anthropic format */
interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Request body for the Anthropic Messages API */
interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicToolDef[];
  stream?: boolean;
}

/** Response content block from the API */
interface AnthropicResponseTextBlock {
  type: "text";
  text: string;
}

interface AnthropicResponseToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type AnthropicResponseContentBlock =
  | AnthropicResponseTextBlock
  | AnthropicResponseToolUseBlock;

/** Usage stats from the API response */
interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Full response from the Anthropic Messages API */
interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicResponseContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

/** Anthropic API error response */
interface AnthropicErrorResponse {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}

// ── Streaming Event Types ───────────────────────────────────────────────────

interface StreamMessageStart {
  type: "message_start";
  message: AnthropicMessagesResponse;
}

interface StreamContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block: AnthropicResponseContentBlock;
}

interface StreamContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string };
}

interface StreamContentBlockStop {
  type: "content_block_stop";
  index: number;
}

interface StreamMessageDelta {
  type: "message_delta";
  delta: {
    stop_reason: string | null;
    stop_sequence: string | null;
  };
  usage: {
    output_tokens: number;
  };
}

interface StreamMessageStop {
  type: "message_stop";
}

interface StreamPing {
  type: "ping";
}

interface StreamError {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}

type AnthropicStreamEvent =
  | StreamMessageStart
  | StreamContentBlockStart
  | StreamContentBlockDelta
  | StreamContentBlockStop
  | StreamMessageDelta
  | StreamMessageStop
  | StreamPing
  | StreamError;

// ── Constants ───────────────────────────────────────────────────────────────

const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8192;
const MAX_ALLOWED_TOKENS = 64000;

// ── Anthropic Provider Implementation ───────────────────────────────────────

class AnthropicProvider extends BaseProvider {
  constructor(apiKey: string, baseUrl: string) {
    super(apiKey, baseUrl);
  }

  // ── Provider Info ───────────────────────────────────────────────────

  getInfo(): ProviderInfo {
    return {
      id: AI_PROVIDER.ANTHROPIC,
      label: AI_PROVIDER_LABELS[AI_PROVIDER.ANTHROPIC],
      baseUrl: this.baseUrl,
      isLocal: false,
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: true,
      maxContextTokens: 200_000,
      envKeyName: AI_PROVIDER_ENV_KEYS[AI_PROVIDER.ANTHROPIC],
    };
  }

  // ── Model Discovery ─────────────────────────────────────────────────

  async listModels(): Promise<ModelFetchResult> {
    return fetchModels(AI_PROVIDER.ANTHROPIC, this.apiKey, this.baseUrl);
  }

  // ── Health Check ────────────────────────────────────────────────────

  async healthCheck(): Promise<ProviderHealthCheck> {
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

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const start = performance.now();

    try {
      // Build the Anthropic request body
      const body = this.buildRequestBody(request, false);

      // Execute the HTTP request
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: request.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });

      const durationMs = performance.now() - start;

      // Handle error responses
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        let errorMessage = `HTTP ${response.status} ${response.statusText}`;

        try {
          const parsed = JSON.parse(errorBody) as AnthropicErrorResponse;
          if (parsed?.error?.message) {
            errorMessage = `${parsed.error.type}: ${parsed.error.message}`;
          }
        } catch {
          if (errorBody) {
            errorMessage += `: ${errorBody.slice(0, 300)}`;
          }
        }

        return this.buildErrorResponse(errorMessage, response.status, durationMs);
      }

      // Parse the successful response
      const data = (await response.json()) as AnthropicMessagesResponse;
      return this.parseResponse(data, durationMs);
    } catch (err) {
      const durationMs = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        return this.buildErrorResponse(
          `Request timed out after ${HTTP_TIMEOUT_MS / 1000}s`,
          408,
          durationMs
        );
      }

      return this.buildErrorResponse(`Request failed: ${message}`, undefined, durationMs);
    }
  }

  // ── Streaming Chat Completion ───────────────────────────────────────

  async chatStream(
    request: StreamingChatCompletionRequest
  ): Promise<ChatCompletionResponse> {
    const start = performance.now();

    try {
      const body = this.buildRequestBody(request, true);

      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: request.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS * 3),
      });

      const durationMs = performance.now() - start;

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        let errorMessage = `HTTP ${response.status} ${response.statusText}`;

        try {
          const parsed = JSON.parse(errorBody) as AnthropicErrorResponse;
          if (parsed?.error?.message) {
            errorMessage = `${parsed.error.type}: ${parsed.error.message}`;
          }
        } catch {
          if (errorBody) {
            errorMessage += `: ${errorBody.slice(0, 300)}`;
          }
        }

        return this.buildErrorResponse(errorMessage, response.status, durationMs);
      }

      if (!response.body) {
        return this.buildErrorResponse("No response body for streaming", undefined, durationMs);
      }

      // Process the SSE stream
      return await this.processStream(response.body, request.onDelta, start);
    } catch (err) {
      const durationMs = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        return this.buildErrorResponse(
          `Stream timed out after ${(HTTP_TIMEOUT_MS * 3) / 1000}s`,
          408,
          durationMs
        );
      }

      return this.buildErrorResponse(`Stream failed: ${message}`, undefined, durationMs);
    }
  }

  // ── Request Building ────────────────────────────────────────────────

  /**
   * Build the HTTP headers required for all Anthropic API requests.
   */
  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    };
  }

  /**
   * Transform our unified ChatCompletionRequest into the Anthropic
   * Messages API request body format.
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
    stream: boolean
  ): AnthropicMessagesRequest {
    const model = request.model || this.selectedModel;
    if (!model) {
      throw new Error("No model specified. Set a model via configuration or pass it in the request.");
    }

    const messages = this.transformMessages(request.messages);

    // Clamp max tokens within allowed range
    const maxTokens = Math.min(
      request.maxTokens ?? DEFAULT_MAX_TOKENS,
      MAX_ALLOWED_TOKENS
    );

    const body: AnthropicMessagesRequest = {
      model,
      messages,
      max_tokens: maxTokens,
    };

    // System prompt — Anthropic accepts it as a top-level string
    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }

    // Sampling parameters
    if (request.temperature !== undefined) {
      body.temperature = Math.max(0, Math.min(1, request.temperature));
    }

    if (request.topP !== undefined) {
      body.top_p = Math.max(0, Math.min(1, request.topP));
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      body.stop_sequences = request.stopSequences;
    }

    // Tool definitions
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => this.transformToolDefinition(tool));
    }

    // Streaming flag
    if (stream) {
      body.stream = true;
    }

    return body;
  }

  /**
   * Transform our unified ChatMessage[] into Anthropic's message format.
   *
   * Key differences from our format:
   * - Anthropic doesn't have a "system" role in messages — system prompt
   *   goes to a top-level field.
   * - Messages must strictly alternate user/assistant roles.
   * - Tool results are sent as user messages with tool_result content blocks.
   * - Anthropic uses tool_use_id instead of toolUseId.
   */
  private transformMessages(messages: ChatMessage[]): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      // Skip system messages — they're handled at the top level
      if (msg.role === "system") continue;

      if (msg.role === "tool") {
        // Tool results become user messages with tool_result blocks
        const toolResultBlock: AnthropicToolResultBlock = {
          type: "tool_result",
          tool_use_id: msg.toolUseId ?? msg.name ?? "",
          content: typeof msg.content === "string"
            ? msg.content
            : this.flattenMessageContent(msg),
        };

        // Check if the last message is already a user message — if so,
        // append this block to it (Anthropic requires alternating roles)
        const lastMsg = result[result.length - 1];
        if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
          lastMsg.content.push(toolResultBlock);
        } else {
          result.push({
            role: "user",
            content: [toolResultBlock],
          });
        }
        continue;
      }

      const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";

      // Handle content blocks
      if (typeof msg.content === "string") {
        // Simple text message — check if we need to merge with previous
        // same-role message (Anthropic requires strict alternation)
        const lastMsg = result[result.length - 1];
        if (lastMsg && lastMsg.role === role) {
          // Merge into previous message
          if (typeof lastMsg.content === "string") {
            lastMsg.content = [
              { type: "text", text: lastMsg.content },
              { type: "text", text: msg.content },
            ];
          } else if (Array.isArray(lastMsg.content)) {
            lastMsg.content.push({ type: "text", text: msg.content });
          }
        } else {
          result.push({ role, content: msg.content });
        }
      } else {
        // Content blocks — transform each one
        const blocks: AnthropicContentBlock[] = [];

        for (const block of msg.content) {
          switch (block.type) {
            case "text":
              blocks.push({ type: "text", text: block.text });
              break;

            case "tool_use":
              blocks.push({
                type: "tool_use",
                id: block.id,
                name: block.name,
                input: block.input,
              });
              break;

            case "tool_result":
              blocks.push({
                type: "tool_result",
                tool_use_id: block.toolUseId,
                content: block.content,
                is_error: block.isError,
              });
              break;
          }
        }

        if (blocks.length > 0) {
          const lastMsg = result[result.length - 1];
          if (lastMsg && lastMsg.role === role && Array.isArray(lastMsg.content)) {
            // Merge blocks into previous same-role message
            lastMsg.content.push(...blocks);
          } else {
            result.push({ role, content: blocks });
          }
        }
      }
    }

    // Ensure the conversation starts with a user message
    if (result.length > 0 && result[0]!.role !== "user") {
      result.unshift({
        role: "user",
        content: "Hello.",
      });
    }

    // Ensure strict user/assistant alternation by inserting placeholder messages
    const fixed: AnthropicMessage[] = [];
    for (let i = 0; i < result.length; i++) {
      const current = result[i]!;

      if (i > 0) {
        const prev = fixed[fixed.length - 1]!;
        if (prev.role === current.role) {
          // Insert a placeholder of the opposite role
          const placeholderRole = current.role === "user" ? "assistant" : "user";
          fixed.push({
            role: placeholderRole,
            content: placeholderRole === "assistant"
              ? "I understand. Please continue."
              : "Continue.",
          });
        }
      }

      fixed.push(current);
    }

    return fixed;
  }

  /**
   * Transform our unified ToolDefinition into Anthropic's tool format.
   */
  private transformToolDefinition(tool: ToolDefinition): AnthropicToolDef {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: tool.parameters.properties as Record<string, unknown>,
        required: tool.parameters.required,
      },
    };
  }

  // ── Response Parsing ────────────────────────────────────────────────

  /**
   * Parse an Anthropic Messages API response into our unified format.
   */
  private parseResponse(
    data: AnthropicMessagesResponse,
    durationMs: number
  ): ChatCompletionResponse {
    const contentBlocks: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of data.content) {
      switch (block.type) {
        case "text": {
          const textBlock: TextContent = {
            type: "text",
            text: block.text,
          };
          contentBlocks.push(textBlock);
          break;
        }

        case "tool_use": {
          const toolUseBlock: ToolUseContent = {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          };
          contentBlocks.push(toolUseBlock);

          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
          break;
        }
      }
    }

    const text = this.extractText(contentBlocks);
    const stopReason = this.mapStopReason(data.stop_reason);

    const usage: TokenUsage = {
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
      totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      cachedTokens: data.usage.cache_read_input_tokens,
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
   * Map Anthropic's stop_reason string to our unified StopReason.
   */
  private mapStopReason(reason: string | null): StopReason {
    switch (reason) {
      case "end_turn":
        return "end_turn";
      case "stop_sequence":
        return "stop_sequence";
      case "max_tokens":
        return "max_tokens";
      case "tool_use":
        return "tool_use";
      default:
        return reason ? "unknown" : "end_turn";
    }
  }

  // ── Stream Processing ───────────────────────────────────────────────

  /**
   * Process an Anthropic SSE stream, accumulating content blocks and
   * invoking the delta callback for each event.
   */
  private async processStream(
    body: ReadableStream<Uint8Array>,
    onDelta: (delta: StreamDelta) => void,
    startTime: number
  ): Promise<ChatCompletionResponse> {
    const decoder = new TextDecoder();
    const reader = body.getReader();

    // Accumulated state
    const contentBlocks: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];
    let accumulatedText = "";
    let model = this.selectedModel;
    let stopReason: StopReason = "unknown";
    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    // In-progress tool use blocks (built up incrementally)
    const pendingToolUse = new Map<
      number,
      { id: string; name: string; inputJson: string }
    >();

    // SSE line buffer
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // Keep the incomplete last line in the buffer

        for (const line of lines) {
          const trimmed = line.trim();

          // Skip empty lines and comments
          if (!trimmed || trimmed.startsWith(":")) continue;

          // Parse "event: <type>" lines
          if (trimmed.startsWith("event:")) continue;

          // Parse "data: <json>" lines
          if (!trimmed.startsWith("data:")) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          let event: AnthropicStreamEvent;
          try {
            event = JSON.parse(jsonStr) as AnthropicStreamEvent;
          } catch {
            continue; // Skip malformed JSON
          }

          switch (event.type) {
            case "message_start": {
              model = event.message.model;
              if (event.message.usage) {
                usage.promptTokens = event.message.usage.input_tokens;
                usage.cachedTokens = event.message.usage.cache_read_input_tokens;
              }
              break;
            }

            case "content_block_start": {
              const block = event.content_block;
              if (block.type === "tool_use") {
                pendingToolUse.set(event.index, {
                  id: block.id,
                  name: block.name,
                  inputJson: "",
                });

                onDelta({
                  toolUse: {
                    id: block.id,
                    name: block.name,
                  },
                });
              }
              break;
            }

            case "content_block_delta": {
              const delta = event.delta;

              if (delta.type === "text_delta") {
                accumulatedText += delta.text;
                onDelta({ text: delta.text });
              } else if (delta.type === "input_json_delta") {
                const pending = pendingToolUse.get(event.index);
                if (pending) {
                  pending.inputJson += delta.partial_json;
                  onDelta({
                    toolUse: {
                      id: pending.id,
                      inputDelta: delta.partial_json,
                    },
                  });
                }
              }
              break;
            }

            case "content_block_stop": {
              // Finalize any pending tool use at this index
              const pending = pendingToolUse.get(event.index);
              if (pending) {
                let input: Record<string, unknown> = {};
                try {
                  if (pending.inputJson) {
                    input = JSON.parse(pending.inputJson) as Record<string, unknown>;
                  }
                } catch {
                  input = { _raw: pending.inputJson };
                }

                const toolUseBlock: ToolUseContent = {
                  type: "tool_use",
                  id: pending.id,
                  name: pending.name,
                  input,
                };
                contentBlocks.push(toolUseBlock);
                toolCalls.push({
                  id: pending.id,
                  name: pending.name,
                  input,
                });

                pendingToolUse.delete(event.index);
              } else {
                // This was a text block that's now complete
                // We'll finalize text content at the end
              }
              break;
            }

            case "message_delta": {
              stopReason = this.mapStopReason(event.delta.stop_reason);
              if (event.usage) {
                usage.completionTokens = event.usage.output_tokens;
                usage.totalTokens = usage.promptTokens + usage.completionTokens;
              }

              onDelta({ stopReason, usage });
              break;
            }

            case "message_stop": {
              // Stream is complete
              break;
            }

            case "error": {
              const errMsg = event.error?.message ?? "Unknown stream error";
              return this.buildErrorResponse(
                `Stream error: ${errMsg}`,
                undefined,
                performance.now() - startTime
              );
            }

            case "ping": {
              // Keep-alive — no action needed
              break;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Finalize accumulated text as a content block
    if (accumulatedText) {
      const textBlock: TextContent = {
        type: "text",
        text: accumulatedText,
      };
      contentBlocks.unshift(textBlock);
    }

    const durationMs = performance.now() - startTime;

    // Ensure stop reason reflects tool use if we have tool calls
    if (toolCalls.length > 0 && stopReason !== "tool_use") {
      stopReason = "tool_use";
    }

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
}

// ── Factory Function ────────────────────────────────────────────────────────

/**
 * Create a new Anthropic provider instance.
 *
 * This is the factory function registered with the provider registry.
 * It follows the ProviderFactory signature: (apiKey, baseUrl) => BaseProvider.
 *
 * @param apiKey  - Anthropic API key.
 * @param baseUrl - Base URL for the Anthropic API
 *                  (default: https://api.anthropic.com).
 * @returns A configured AnthropicProvider instance.
 */
export function createProvider(apiKey: string, baseUrl: string): BaseProvider {
  return new AnthropicProvider(apiKey, baseUrl);
}
