// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Cohere Command Provider
// ─────────────────────────────────────────────────────────────────────────────
// Concrete implementation of BaseProvider for the Cohere v2 Chat API.
// Cohere uses a unique API format distinct from both OpenAI and Anthropic,
// with its own message structure, tool definitions, and response format.
//
// Key differences from OpenAI-compatible APIs:
// - Endpoint: POST /v2/chat
// - Auth: Bearer token (same as OpenAI) but different request/response shapes
// - Message format: { role, content } with tool_plan and tool_call roles
// - Tool format: tools[].function with type "function"
// - Tool results: role "tool" with tool_call_id reference
// - Model discovery: GET /v2/models with capabilities-based tool-calling detection
//   (checks endpoints[].chat?.is_tool_use_supported for each model)
// - Streaming: SSE with event types like "content-start", "content-delta",
//   "tool-call-start", "tool-call-delta", "message-end"
//
// Models are fetched dynamically from the /v2/models endpoint at runtime
// and filtered for tool-calling support using the capabilities metadata
// exposed in each model's endpoint configuration. Nothing is hardcoded.
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

// ── Cohere API Types ────────────────────────────────────────────────────────

/** A single message in the Cohere v2 Chat format */
interface CohereMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | CohereContentPart[];
  /** Tool calls emitted by the assistant */
  tool_calls?: CohereToolCall[];
  /** Tool call ID this tool-result message responds to */
  tool_call_id?: string;
  /** Tool plan text (Cohere sometimes emits a "thinking" plan before tool calls) */
  tool_plan?: string;
}

/** Content part within a message (for structured content) */
interface CohereContentPart {
  type: "text";
  text: string;
}

/** A tool call in Cohere's response format */
interface CohereToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Tool definition in Cohere format (mirrors OpenAI's structure) */
interface CohereToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** Request body for the Cohere v2 Chat API */
interface CohereChatRequest {
  model: string;
  messages: CohereMessage[];
  tools?: CohereToolDef[];
  temperature?: number;
  max_tokens?: number;
  p?: number; // top_p equivalent
  stop_sequences?: string[];
  stream?: boolean;
}

/** Response from the Cohere v2 Chat API */
interface CohereChatResponse {
  id: string;
  message: {
    role: "assistant";
    content?: CohereContentPart[];
    tool_calls?: CohereToolCall[];
    tool_plan?: string;
  };
  finish_reason: string;
  usage?: {
    billed_units?: {
      input_tokens?: number;
      output_tokens?: number;
    };
    tokens?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}

/** Error response from the Cohere API */
interface CohereErrorResponse {
  message?: string;
  status_code?: number;
  detail?: string;
}

// ── Streaming Event Types ───────────────────────────────────────────────────

interface CohereStreamMessageStart {
  type: "message-start";
  id: string;
  delta?: {
    message?: {
      role: "assistant";
      content?: CohereContentPart[];
      tool_calls?: CohereToolCall[];
      tool_plan?: string;
    };
  };
}

interface CohereStreamContentStart {
  type: "content-start";
  index: number;
  delta?: {
    message?: {
      content?: {
        type: "text";
        text: string;
      };
    };
  };
}

interface CohereStreamContentDelta {
  type: "content-delta";
  index: number;
  delta?: {
    message?: {
      content?: {
        text: string;
      };
    };
  };
}

interface CohereStreamContentEnd {
  type: "content-end";
  index: number;
}

interface CohereStreamToolCallStart {
  type: "tool-call-start";
  index: number;
  delta?: {
    message?: {
      tool_calls?: {
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      };
    };
  };
}

interface CohereStreamToolCallDelta {
  type: "tool-call-delta";
  index: number;
  delta?: {
    message?: {
      tool_calls?: {
        function?: {
          arguments?: string;
        };
      };
    };
  };
}

interface CohereStreamToolCallEnd {
  type: "tool-call-end";
  index: number;
}

interface CohereStreamToolPlanDelta {
  type: "tool-plan-delta";
  delta?: {
    message?: {
      tool_plan?: string;
    };
  };
}

interface CohereStreamMessageEnd {
  type: "message-end";
  id?: string;
  delta?: {
    finish_reason?: string;
    usage?: {
      billed_units?: {
        input_tokens?: number;
        output_tokens?: number;
      };
      tokens?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };
  };
}

type CohereStreamEvent =
  | CohereStreamMessageStart
  | CohereStreamContentStart
  | CohereStreamContentDelta
  | CohereStreamContentEnd
  | CohereStreamToolCallStart
  | CohereStreamToolCallDelta
  | CohereStreamToolCallEnd
  | CohereStreamToolPlanDelta
  | CohereStreamMessageEnd;

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 4096;

// ── Cohere Provider Implementation ──────────────────────────────────────────

class CohereProvider extends BaseProvider {
  constructor(apiKey: string, baseUrl: string) {
    super(apiKey, baseUrl);
  }

  // ── Provider Info ───────────────────────────────────────────────────

  getInfo(): ProviderInfo {
    return {
      id: AI_PROVIDER.COHERE,
      label: AI_PROVIDER_LABELS[AI_PROVIDER.COHERE],
      baseUrl: this.baseUrl,
      isLocal: false,
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: false,
      maxContextTokens: 128_000,
      envKeyName: AI_PROVIDER_ENV_KEYS[AI_PROVIDER.COHERE],
    };
  }

  // ── Model Discovery ─────────────────────────────────────────────────

  /**
   * Fetch models from the Cohere API.
   *
   * The /v2/models endpoint returns models with their endpoint capabilities.
   * We use the model-fetcher module which checks
   * `endpoints.chat.is_tool_use_supported` for each model to determine
   * tool-calling capability (via the "capabilities_field" detection strategy
   * configured in MODEL_DISCOVERY).
   *
   * Models like embedding-only or rerank-only models are automatically
   * excluded because they lack chat endpoints and thus fail the
   * capabilities check.
   */
  async listModels(): Promise<ModelFetchResult> {
    const result = await fetchModels(
      AI_PROVIDER.COHERE,
      this.apiKey,
      this.baseUrl
    );

    if (!result.ok) return result;

    // Additional filtering: only keep models that have "command" in the name
    // or are explicitly chat models (excludes embed, rerank, classify models)
    const isChatModel = (m: { id: string }): boolean => {
      const id = m.id.toLowerCase();
      return (
        id.includes("command") ||
        id.includes("c4ai") ||
        id.includes("aya")
      );
    };

    const filteredAll = result.allModels.filter(isChatModel);
    const filteredToolCalling = result.toolCallingModels.filter(isChatModel);

    // Update cached models on this instance
    this.cachedModels =
      filteredToolCalling.length > 0 ? filteredToolCalling : filteredAll;

    return {
      ...result,
      allModels: filteredAll,
      toolCallingModels: filteredToolCalling,
    };
  }

  // ── Health Check ────────────────────────────────────────────────────

  async healthCheck(): Promise<ProviderHealthCheck> {
    const start = performance.now();

    try {
      const result = await this.listModels();
      const latencyMs = performance.now() - start;

      if (!result.ok) {
        let error = result.error ?? "Unknown error";

        // Provide friendlier errors for common Cohere issues
        if (error.includes("401") || error.includes("Unauthorized")) {
          error =
            "Invalid API key. Verify your COHERE_API_KEY is correct and has not been revoked. " +
            "You can manage your keys at https://dashboard.cohere.com/api-keys";
        } else if (error.includes("429") || error.includes("rate")) {
          error =
            "Rate limited by Cohere. Wait a moment and try again, or check your account usage limits.";
        } else if (error.includes("403") || error.includes("Forbidden")) {
          error =
            "API key does not have permission. Check your Cohere account permissions and billing status.";
        }

        return {
          healthy: false,
          latencyMs,
          error,
          modelCount: 0,
        };
      }

      return {
        healthy: true,
        latencyMs,
        modelCount: result.allModels.length,
        metadata: {
          toolCallingModels: result.toolCallingModels.length,
          totalModels: result.allModels.length,
        },
      };
    } catch (err) {
      const latencyMs = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      let friendlyMessage = `Connection failed: ${message}`;

      if (message.includes("fetch") || message.includes("ECONNREFUSED")) {
        friendlyMessage =
          "Cannot reach the Cohere API. Check your network connection and firewall settings.";
      } else if (
        message.includes("timeout") ||
        message.includes("TimeoutError")
      ) {
        friendlyMessage =
          "Connection to Cohere timed out. The API may be experiencing high load.";
      }

      return {
        healthy: false,
        latencyMs,
        error: friendlyMessage,
        modelCount: 0,
      };
    }
  }

  // ── Chat Completion ─────────────────────────────────────────────────

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const start = performance.now();

    try {
      const model = request.model || this.selectedModel;
      if (!model) {
        return this.buildErrorResponse(
          "No model specified. Set a model via configuration or pass it in the request.",
          undefined,
          0
        );
      }

      const body = this.buildRequestBody(request, model, false);
      const url = `${this.baseUrl}/v2/chat`;

      const response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: request.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });

      const durationMs = performance.now() - start;

      if (!response.ok) {
        return await this.handleErrorResponse(response, durationMs);
      }

      const data = (await response.json()) as CohereChatResponse;
      return this.parseResponse(data, model, durationMs);
    } catch (err) {
      return this.handleFetchError(err, start);
    }
  }

  // ── Streaming Chat Completion ───────────────────────────────────────

  async chatStream(
    request: StreamingChatCompletionRequest
  ): Promise<ChatCompletionResponse> {
    const start = performance.now();

    try {
      const model = request.model || this.selectedModel;
      if (!model) {
        return this.buildErrorResponse(
          "No model specified. Set a model via configuration or pass it in the request.",
          undefined,
          0
        );
      }

      const body = this.buildRequestBody(request, model, true);
      const url = `${this.baseUrl}/v2/chat`;

      const response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: request.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS * 3),
      });

      const durationMs = performance.now() - start;

      if (!response.ok) {
        return await this.handleErrorResponse(response, durationMs);
      }

      if (!response.body) {
        return this.buildErrorResponse(
          "No response body for streaming",
          undefined,
          durationMs
        );
      }

      return await this.processStream(
        response.body,
        request.onDelta,
        model,
        start
      );
    } catch (err) {
      return this.handleFetchError(err, start);
    }
  }

  // ── Request Building ────────────────────────────────────────────────

  /**
   * Build HTTP headers for Cohere API requests.
   * Cohere uses Bearer token authentication.
   */
  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  /**
   * Transform our unified ChatCompletionRequest into the Cohere v2 Chat
   * request body format.
   *
   * The Cohere v2 API uses a message format that is similar to but not
   * identical to OpenAI's:
   * - System messages are supported directly in the messages array
   * - Tool results use role "tool" with tool_call_id
   * - Assistant tool calls use the tool_calls field
   * - Tool definitions follow the OpenAI function schema structure
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
    model: string,
    stream: boolean
  ): CohereChatRequest {
    const messages = this.transformMessages(
      request.messages,
      request.systemPrompt
    );

    const body: CohereChatRequest = {
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
      body.temperature = Math.max(0, Math.min(1, request.temperature));
    }

    // Cohere uses "p" instead of "top_p"
    if (request.topP !== undefined) {
      body.p = Math.max(0, Math.min(1, request.topP));
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      body.stop_sequences = request.stopSequences;
    }

    // Tool definitions
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) =>
        this.transformToolDefinition(tool)
      );
    }

    // Streaming
    if (stream) {
      body.stream = true;
    }

    return body;
  }

  /**
   * Transform our unified ChatMessage[] into the Cohere v2 message format.
   *
   * Cohere's v2 API supports the following roles:
   * - "system" → system prompt (can appear as first message)
   * - "user" → user messages
   * - "assistant" → model responses, may contain tool_calls or tool_plan
   * - "tool" → tool execution results, must reference tool_call_id
   *
   * Message structure follows similar patterns to OpenAI but with some
   * Cohere-specific fields like tool_plan.
   */
  private transformMessages(
    messages: ChatMessage[],
    systemPrompt?: string
  ): CohereMessage[] {
    const result: CohereMessage[] = [];

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
            const toolCalls: CohereToolCall[] = [];

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

            const cohereMsg: CohereMessage = {
              role: "assistant",
            };

            if (textParts.length > 0) {
              cohereMsg.content = textParts.join("");
            }

            if (toolCalls.length > 0) {
              cohereMsg.tool_calls = toolCalls;
              // If no text content was produced but tool calls exist, Cohere
              // expects content to be absent or empty string
              if (textParts.length === 0) {
                cohereMsg.content = "";
              }
            }

            result.push(cohereMsg);
          }
          break;
        }

        case "tool": {
          // Tool result messages — Cohere uses tool_call_id to link
          // results back to the assistant's tool_calls
          const content = this.getTextContent(msg);

          result.push({
            role: "tool",
            tool_call_id: msg.toolUseId ?? msg.name ?? "",
            content: content,
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
          b
        ): b is
          | TextContent
          | {
              type: "tool_result";
              content: string;
              toolUseId: string;
            } => b.type === "text" || b.type === "tool_result"
      )
      .map((b) => {
        if (b.type === "text") return b.text;
        if ("content" in b) return b.content;
        return "";
      })
      .join("");
  }

  /**
   * Transform our unified ToolDefinition into Cohere's tool format.
   * Cohere's v2 API uses the same function tool schema as OpenAI.
   */
  private transformToolDefinition(tool: ToolDefinition): CohereToolDef {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: tool.parameters.properties as Record<string, unknown>,
          required: tool.parameters.required,
        },
      },
    };
  }

  // ── Response Parsing ────────────────────────────────────────────────

  /**
   * Parse a Cohere v2 Chat response into our unified format.
   *
   * Cohere's response structure:
   * - `message.content`: array of { type: "text", text: "..." } parts
   * - `message.tool_calls`: array of tool call objects
   * - `message.tool_plan`: optional thinking/planning text before tool calls
   * - `finish_reason`: "COMPLETE", "MAX_TOKENS", "STOP_SEQUENCE", "TOOL_CALL"
   * - `usage.tokens`: { input_tokens, output_tokens }
   */
  private parseResponse(
    data: CohereChatResponse,
    model: string,
    durationMs: number
  ): ChatCompletionResponse {
    const contentBlocks: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];

    // Extract tool plan as a text block (if present)
    if (data.message?.tool_plan) {
      const planBlock: TextContent = {
        type: "text",
        text: data.message.tool_plan,
      };
      contentBlocks.push(planBlock);
    }

    // Extract text content
    if (data.message?.content) {
      for (const part of data.message.content) {
        if (part.type === "text" && part.text) {
          const textBlock: TextContent = {
            type: "text",
            text: part.text,
          };
          contentBlocks.push(textBlock);
        }
      }
    }

    // Extract tool calls
    if (data.message?.tool_calls) {
      for (const tc of data.message.tool_calls) {
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
    const stopReason = this.mapFinishReason(data.finish_reason);

    // Parse usage — Cohere reports usage in two places, prefer `tokens`
    const tokens = data.usage?.tokens;
    const billedUnits = data.usage?.billed_units;

    const inputTokens =
      tokens?.input_tokens ?? billedUnits?.input_tokens ?? 0;
    const outputTokens =
      tokens?.output_tokens ?? billedUnits?.output_tokens ?? 0;

    const usage: TokenUsage = {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    };

    return {
      ok: true,
      text,
      contentBlocks,
      toolCalls,
      stopReason,
      usage,
      model,
      durationMs,
      raw: data,
    };
  }

  /**
   * Map Cohere's finish_reason string to our unified StopReason.
   *
   * Cohere finish reasons:
   * - "COMPLETE" → normal completion
   * - "MAX_TOKENS" → hit token limit
   * - "STOP_SEQUENCE" → hit a stop sequence
   * - "TOOL_CALL" → model wants to call a tool
   * - "ERROR" → an error occurred
   */
  private mapFinishReason(reason: string | null | undefined): StopReason {
    switch (reason?.toUpperCase()) {
      case "COMPLETE":
        return "end_turn";
      case "MAX_TOKENS":
        return "max_tokens";
      case "STOP_SEQUENCE":
        return "stop_sequence";
      case "TOOL_CALL":
        return "tool_use";
      case "ERROR":
        return "error";
      default:
        return reason ? "unknown" : "end_turn";
    }
  }

  // ── Stream Processing ───────────────────────────────────────────────

  /**
   * Process a Cohere SSE stream, accumulating content blocks and tool
   * calls, invoking the delta callback for each event.
   *
   * Cohere's streaming format uses typed events:
   * - "message-start" → start of the message (may include initial metadata)
   * - "content-start" → a content block is beginning
   * - "content-delta" → incremental text content
   * - "content-end" → a content block is complete
   * - "tool-call-start" → a new tool call is beginning
   * - "tool-call-delta" → incremental tool call arguments
   * - "tool-call-end" → a tool call is complete
   * - "tool-plan-delta" → incremental tool plan (thinking) text
   * - "message-end" → end of message with finish_reason and usage
   */
  private async processStream(
    body: ReadableStream<Uint8Array>,
    onDelta: (delta: StreamDelta) => void,
    model: string,
    startTime: number
  ): Promise<ChatCompletionResponse> {
    const decoder = new TextDecoder();
    const reader = body.getReader();

    // Accumulated state
    let accumulatedText = "";
    let accumulatedToolPlan = "";
    let stopReason: StopReason = "unknown";
    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    // In-progress tool calls indexed by stream index
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; argumentsJson: string }
    >();

    // SSE line buffer
    let buffer = "";
    let currentEventType = "";

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

          // Skip empty lines (SSE event separator)
          if (!trimmed) {
            currentEventType = "";
            continue;
          }

          // Skip SSE comments
          if (trimmed.startsWith(":")) continue;

          // Capture event type
          if (trimmed.startsWith("event:")) {
            currentEventType = trimmed.slice(6).trim();
            continue;
          }

          // Process data lines
          if (!trimmed.startsWith("data:")) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          let event: CohereStreamEvent;
          try {
            event = JSON.parse(jsonStr) as CohereStreamEvent;
          } catch {
            continue; // Skip malformed JSON
          }

          // Use the parsed type from the JSON if available, fall back to
          // the SSE event type header
          const eventType = event.type || currentEventType;

          switch (eventType) {
            case "message-start": {
              // Initial message metadata — nothing to accumulate yet
              break;
            }

            case "content-start": {
              // A content block is beginning — nothing to accumulate yet
              break;
            }

            case "content-delta": {
              const evt = event as CohereStreamContentDelta;
              const text = evt.delta?.message?.content?.text;

              if (text) {
                accumulatedText += text;
                onDelta({ text });
              }
              break;
            }

            case "content-end": {
              // Content block complete — no action needed, text is accumulated
              break;
            }

            case "tool-plan-delta": {
              const evt = event as CohereStreamToolPlanDelta;
              const planText = evt.delta?.message?.tool_plan;

              if (planText) {
                accumulatedToolPlan += planText;
                // Emit tool plan as regular text to show the model's thinking
                onDelta({ text: planText });
              }
              break;
            }

            case "tool-call-start": {
              const evt = event as CohereStreamToolCallStart;
              const tc = evt.delta?.message?.tool_calls;

              if (tc) {
                pendingToolCalls.set(evt.index, {
                  id: tc.id,
                  name: tc.function.name,
                  argumentsJson: tc.function.arguments ?? "",
                });

                onDelta({
                  toolUse: {
                    id: tc.id,
                    name: tc.function.name,
                  },
                });
              }
              break;
            }

            case "tool-call-delta": {
              const evt = event as CohereStreamToolCallDelta;
              const argsDelta =
                evt.delta?.message?.tool_calls?.function?.arguments;

              if (argsDelta) {
                const pending = pendingToolCalls.get(evt.index);
                if (pending) {
                  pending.argumentsJson += argsDelta;
                  onDelta({
                    toolUse: {
                      id: pending.id,
                      inputDelta: argsDelta,
                    },
                  });
                }
              }
              break;
            }

            case "tool-call-end": {
              // Tool call complete — finalization happens after stream ends
              break;
            }

            case "message-end": {
              const evt = event as CohereStreamMessageEnd;

              if (evt.delta?.finish_reason) {
                stopReason = this.mapFinishReason(evt.delta.finish_reason);
                onDelta({ stopReason });
              }

              if (evt.delta?.usage) {
                const tokens = evt.delta.usage.tokens;
                const billedUnits = evt.delta.usage.billed_units;

                const inputTokens =
                  tokens?.input_tokens ?? billedUnits?.input_tokens ?? 0;
                const outputTokens =
                  tokens?.output_tokens ?? billedUnits?.output_tokens ?? 0;

                usage = {
                  promptTokens: inputTokens,
                  completionTokens: outputTokens,
                  totalTokens: inputTokens + outputTokens,
                };

                onDelta({ usage });
              }
              break;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // ── Finalize accumulated content ──────────────────────────────────

    const contentBlocks: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];

    // Add tool plan as a text block if present
    if (accumulatedToolPlan) {
      const planBlock: TextContent = {
        type: "text",
        text: accumulatedToolPlan,
      };
      contentBlocks.push(planBlock);
    }

    // Add accumulated text content
    if (accumulatedText) {
      const textBlock: TextContent = {
        type: "text",
        text: accumulatedText,
      };
      contentBlocks.push(textBlock);
    }

    // Finalize all pending tool calls
    const sortedEntries = Array.from(pendingToolCalls.entries()).sort(
      ([a], [b]) => a - b
    );

    for (const [, pending] of sortedEntries) {
      let input: Record<string, unknown> = {};
      try {
        if (pending.argumentsJson) {
          input = JSON.parse(
            pending.argumentsJson
          ) as Record<string, unknown>;
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

    // Combine tool plan and text for the final text output
    const fullText = [accumulatedToolPlan, accumulatedText]
      .filter(Boolean)
      .join("\n\n");

    const durationMs = performance.now() - startTime;

    return {
      ok: true,
      text: fullText,
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
   * Handle a non-OK HTTP response from the Cohere API.
   */
  private async handleErrorResponse(
    response: Response,
    durationMs: number
  ): Promise<ChatCompletionResponse> {
    const errorBody = await response.text().catch(() => "");
    let errorMessage = `HTTP ${response.status} ${response.statusText}`;

    try {
      const parsed = JSON.parse(errorBody) as CohereErrorResponse;
      const msg = parsed?.message ?? parsed?.detail ?? errorBody.slice(0, 300);
      if (msg) {
        errorMessage = msg;
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
    startTime: number
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
        durationMs
      );
    }

    return this.buildErrorResponse(
      `Request failed: ${message}`,
      undefined,
      durationMs
    );
  }
}

// ── Factory Function ────────────────────────────────────────────────────────

/**
 * Create a new Cohere provider instance.
 *
 * This is the factory function registered with the provider registry.
 * It follows the ProviderFactory signature: (apiKey, baseUrl) => BaseProvider.
 *
 * @param apiKey  - Cohere API key (from https://dashboard.cohere.com/api-keys).
 * @param baseUrl - Base URL for the Cohere API
 *                  (default: https://api.cohere.com).
 * @returns A configured CohereProvider instance.
 */
export function createProvider(
  apiKey: string,
  baseUrl: string
): BaseProvider {
  return new CohereProvider(apiKey, baseUrl);
}
