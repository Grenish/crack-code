// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Google Gemini Provider
// ─────────────────────────────────────────────────────────────────────────────
// Concrete implementation of BaseProvider for Google's Gemini API.
// Unlike OpenAI-compatible providers, Gemini uses a unique request/response
// format with query-parameter authentication, /v1beta endpoints, and
// generateContent-based tool calling.
//
// Key differences from OpenAI-compatible APIs:
// - Auth: API key passed as ?key=<key> query parameter (not Bearer token)
// - Endpoint: /v1beta/models/<model>:generateContent
// - Message format: { contents: [{ role, parts }] } instead of messages
// - Tool format: functionDeclarations instead of functions
// - Streaming: /v1beta/models/<model>:streamGenerateContent?alt=sse
//
// Models are fetched dynamically from the /v1beta/models endpoint and
// filtered for those that include "generateContent" in their
// supportedGenerationMethods — which indicates tool-calling capability.
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

// ── Gemini API Types ────────────────────────────────────────────────────────

/** A single part within a Gemini content block */
interface GeminiTextPart {
  text: string;
}

interface GeminiFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

interface GeminiFunctionResponsePart {
  functionResponse: {
    name: string;
    response: {
      name: string;
      content: unknown;
    };
  };
}

type GeminiPart = GeminiTextPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;

/** A single content entry in the Gemini API format */
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** System instruction (separate from conversation contents) */
interface GeminiSystemInstruction {
  parts: GeminiTextPart[];
}

/** Function declaration in Gemini format */
interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Tool definition wrapper */
interface GeminiToolDef {
  functionDeclarations: GeminiFunctionDeclaration[];
}

/** Generation configuration */
interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
}

/** Full request body for generateContent */
interface GeminiGenerateRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiSystemInstruction;
  tools?: GeminiToolDef[];
  generationConfig?: GeminiGenerationConfig;
}

/** A single candidate in the response */
interface GeminiCandidate {
  content: {
    role: "model";
    parts: GeminiPart[];
  };
  finishReason: string | null;
  index: number;
  safetyRatings?: Array<{
    category: string;
    probability: string;
    blocked?: boolean;
  }>;
}

/** Usage metadata from the response */
interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  cachedContentTokenCount?: number;
}

/** Full response from generateContent */
interface GeminiGenerateResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: Array<{
      category: string;
      probability: string;
    }>;
  };
}

/** Error response from the API */
interface GeminiErrorResponse {
  error?: {
    code: number;
    message: string;
    status: string;
    details?: unknown[];
  };
}

// ── Streaming Types ─────────────────────────────────────────────────────────

/** A single streamed chunk (same structure as GeminiGenerateResponse) */
interface GeminiStreamChunk {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// ── Gemini Provider Implementation ──────────────────────────────────────────

class GeminiProvider extends BaseProvider {
  constructor(apiKey: string, baseUrl: string) {
    super(apiKey, baseUrl);
  }

  // ── Provider Info ───────────────────────────────────────────────────

  getInfo(): ProviderInfo {
    return {
      id: AI_PROVIDER.GEMINI,
      label: AI_PROVIDER_LABELS[AI_PROVIDER.GEMINI],
      baseUrl: this.baseUrl,
      isLocal: false,
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: true,
      maxContextTokens: 1_000_000, // Gemini 1.5 Pro supports up to 1M tokens
      envKeyName: AI_PROVIDER_ENV_KEYS[AI_PROVIDER.GEMINI],
    };
  }

  // ── Model Discovery ─────────────────────────────────────────────────

  /**
   * Fetch models from the Gemini API.
   *
   * The /v1beta/models endpoint returns all available models with their
   * supportedGenerationMethods. We filter for models that include
   * "generateContent" — which indicates they support chat completions
   * and tool/function calling.
   *
   * Models like "embedding-001" or "aqa" that only support "embedContent"
   * or "generateAnswer" are automatically excluded by the model-fetcher's
   * "generation_methods" detection strategy.
   */
  async listModels(): Promise<ModelFetchResult> {
    return fetchModels(AI_PROVIDER.GEMINI, this.apiKey, this.baseUrl);
  }

  // ── Health Check ────────────────────────────────────────────────────

  async healthCheck(): Promise<ProviderHealthCheck> {
    const start = performance.now();

    try {
      const result = await this.listModels();
      const latencyMs = performance.now() - start;

      if (!result.ok) {
        let error = result.error ?? "Unknown error";

        // Provide friendlier errors for common Gemini issues
        if (error.includes("400") || error.includes("API_KEY_INVALID")) {
          error =
            "Invalid API key. Verify your GEMINI_API_KEY is correct. " +
            "You can generate one at https://aistudio.google.com/app/apikey";
        } else if (error.includes("403") || error.includes("PERMISSION_DENIED")) {
          error =
            "API key does not have permission. Ensure the Generative Language API is enabled " +
            "in your Google Cloud project.";
        } else if (error.includes("429") || error.includes("RESOURCE_EXHAUSTED")) {
          error =
            "Rate limited by the Gemini API. Wait a moment and try again, or check your quota.";
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
          "Cannot reach the Gemini API. Check your network connection and firewall settings.";
      } else if (message.includes("timeout") || message.includes("TimeoutError")) {
        friendlyMessage =
          "Connection to Google Gemini timed out. The API may be experiencing high load.";
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

      const body = this.buildRequestBody(request);
      const url = this.buildGenerateUrl(model);

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

      const data = (await response.json()) as GeminiGenerateResponse;
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

      const body = this.buildRequestBody(request);
      const url = this.buildStreamUrl(model);

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

      return await this.processStream(response.body, request.onDelta, model, start);
    } catch (err) {
      return this.handleFetchError(err, start);
    }
  }

  // ── URL Building ────────────────────────────────────────────────────

  /**
   * Build the generateContent endpoint URL.
   * Gemini uses query-parameter authentication: ?key=<API_KEY>
   */
  private buildGenerateUrl(model: string): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    const encodedKey = encodeURIComponent(this.apiKey);
    return `${base}/v1beta/models/${model}:generateContent?key=${encodedKey}`;
  }

  /**
   * Build the streaming endpoint URL.
   * Uses streamGenerateContent with alt=sse for server-sent events.
   */
  private buildStreamUrl(model: string): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    const encodedKey = encodeURIComponent(this.apiKey);
    return `${base}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodedKey}`;
  }

  // ── Request Building ────────────────────────────────────────────────

  /**
   * Build HTTP headers for Gemini requests.
   * Unlike OpenAI-compatible APIs, Gemini does NOT use an Authorization
   * header — the API key is passed as a query parameter.
   */
  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
    };
  }

  /**
   * Transform our unified ChatCompletionRequest into the Gemini
   * generateContent request body format.
   */
  private buildRequestBody(request: ChatCompletionRequest): GeminiGenerateRequest {
    const contents = this.transformMessages(request.messages);

    const body: GeminiGenerateRequest = {
      contents,
    };

    // System instruction (Gemini handles this separately from contents)
    const systemPrompt = request.systemPrompt ?? this.extractSystemPrompt(request.messages);
    if (systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: systemPrompt }],
      };
    }

    // Generation configuration
    const generationConfig: GeminiGenerationConfig = {};
    let hasConfig = false;

    if (request.temperature !== undefined) {
      generationConfig.temperature = Math.max(0, Math.min(2, request.temperature));
      hasConfig = true;
    }

    if (request.topP !== undefined) {
      generationConfig.topP = Math.max(0, Math.min(1, request.topP));
      hasConfig = true;
    }

    if (request.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = request.maxTokens;
      hasConfig = true;
    } else {
      generationConfig.maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
      hasConfig = true;
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      generationConfig.stopSequences = request.stopSequences;
      hasConfig = true;
    }

    if (hasConfig) {
      body.generationConfig = generationConfig;
    }

    // Tool definitions
    if (request.tools && request.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((tool) =>
            this.transformToolDefinition(tool)
          ),
        },
      ];
    }

    return body;
  }

  /**
   * Transform our unified ChatMessage[] into Gemini's contents format.
   *
   * Key mapping:
   * - "user" → role: "user"
   * - "assistant" → role: "model"
   * - "system" → extracted separately as systemInstruction
   * - "tool" → role: "user" with functionResponse parts
   *
   * Gemini requires strict alternation between "user" and "model" roles.
   * Consecutive same-role messages are merged into a single content entry.
   */
  private transformMessages(messages: ChatMessage[]): GeminiContent[] {
    const result: GeminiContent[] = [];

    for (const msg of messages) {
      // System messages are handled separately via systemInstruction
      if (msg.role === "system") continue;

      if (msg.role === "tool") {
        // Tool results become user messages with functionResponse parts
        const toolName = msg.name ?? "unknown_tool";
        const responseContent = typeof msg.content === "string"
          ? msg.content
          : this.flattenMessageContent(msg);

        let parsedContent: unknown;
        try {
          parsedContent = JSON.parse(responseContent);
        } catch {
          parsedContent = { result: responseContent };
        }

        const part: GeminiFunctionResponsePart = {
          functionResponse: {
            name: toolName,
            response: {
              name: toolName,
              content: parsedContent,
            },
          },
        };

        // Merge with previous user content if possible
        const lastMsg = result[result.length - 1];
        if (lastMsg && lastMsg.role === "user") {
          lastMsg.parts.push(part);
        } else {
          result.push({
            role: "user",
            parts: [part],
          });
        }
        continue;
      }

      const geminiRole: "user" | "model" = msg.role === "assistant" ? "model" : "user";
      const parts = this.messageContentToParts(msg);

      if (parts.length === 0) continue;

      // Merge consecutive same-role messages
      const lastMsg = result[result.length - 1];
      if (lastMsg && lastMsg.role === geminiRole) {
        lastMsg.parts.push(...parts);
      } else {
        result.push({
          role: geminiRole,
          parts,
        });
      }
    }

    // Gemini requires the conversation to start with a "user" role
    if (result.length > 0 && result[0]!.role !== "user") {
      result.unshift({
        role: "user",
        parts: [{ text: "Hello." }],
      });
    }

    // Ensure strict user/model alternation by inserting placeholder messages
    const fixed: GeminiContent[] = [];
    for (let i = 0; i < result.length; i++) {
      const current = result[i]!;

      if (i > 0) {
        const prev = fixed[fixed.length - 1]!;
        if (prev.role === current.role) {
          const placeholderRole = current.role === "user" ? "model" : "user";
          fixed.push({
            role: placeholderRole,
            parts: [
              {
                text:
                  placeholderRole === "model"
                    ? "I understand. Please continue."
                    : "Continue.",
              },
            ],
          });
        }
      }

      fixed.push(current);
    }

    return fixed;
  }

  /**
   * Convert a ChatMessage's content into an array of Gemini parts.
   */
  private messageContentToParts(msg: ChatMessage): GeminiPart[] {
    if (typeof msg.content === "string") {
      if (!msg.content.trim()) return [];
      return [{ text: msg.content }];
    }

    const parts: GeminiPart[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          if (block.text.trim()) {
            parts.push({ text: block.text });
          }
          break;

        case "tool_use":
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input,
            },
          });
          break;

        case "tool_result": {
          let parsedContent: unknown;
          try {
            parsedContent = JSON.parse(block.content);
          } catch {
            parsedContent = { result: block.content };
          }

          parts.push({
            functionResponse: {
              name: block.toolUseId,
              response: {
                name: block.toolUseId,
                content: parsedContent,
              },
            },
          });
          break;
        }
      }
    }

    return parts;
  }

  /**
   * Extract a system prompt from the messages array (if one exists).
   */
  private extractSystemPrompt(messages: ChatMessage[]): string | undefined {
    const systemMsgs = messages.filter((m) => m.role === "system");
    if (systemMsgs.length === 0) return undefined;

    return systemMsgs
      .map((m) =>
        typeof m.content === "string" ? m.content : this.flattenMessageContent(m)
      )
      .join("\n\n");
  }

  /**
   * Transform our unified ToolDefinition into Gemini's function declaration format.
   */
  private transformToolDefinition(tool: ToolDefinition): GeminiFunctionDeclaration {
    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: tool.parameters.properties as Record<string, unknown>,
        required: tool.parameters.required,
      },
    };
  }

  // ── Response Parsing ────────────────────────────────────────────────

  /**
   * Parse a Gemini generateContent response into our unified format.
   */
  private parseResponse(
    data: GeminiGenerateResponse,
    model: string,
    durationMs: number
  ): ChatCompletionResponse {
    // Check for prompt feedback blocking
    if (data.promptFeedback?.blockReason) {
      return this.buildErrorResponse(
        `Request blocked by safety filter: ${data.promptFeedback.blockReason}`,
        400,
        durationMs
      );
    }

    const candidate = data.candidates?.[0];
    if (!candidate) {
      return this.buildErrorResponse(
        "No candidates returned in the response",
        undefined,
        durationMs
      );
    }

    const contentBlocks: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];

    if (candidate.content?.parts) {
      for (const part of candidate.content.parts) {
        if ("text" in part) {
          const textBlock: TextContent = {
            type: "text",
            text: part.text,
          };
          contentBlocks.push(textBlock);
        } else if ("functionCall" in part) {
          const id = this.generateToolUseId();
          const toolUseBlock: ToolUseContent = {
            type: "tool_use",
            id,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {},
          };
          contentBlocks.push(toolUseBlock);

          toolCalls.push({
            id,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {},
          });
        }
      }
    }

    const text = this.extractText(contentBlocks);
    const stopReason = this.mapFinishReason(candidate.finishReason);

    const usage: TokenUsage = {
      promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
      cachedTokens: data.usageMetadata?.cachedContentTokenCount,
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
   * Map Gemini's finishReason string to our unified StopReason.
   */
  private mapFinishReason(reason: string | null): StopReason {
    switch (reason) {
      case "STOP":
        return "end_turn";
      case "MAX_TOKENS":
        return "max_tokens";
      case "SAFETY":
        return "end_turn";
      case "RECITATION":
        return "end_turn";
      case "FINISH_REASON_UNSPECIFIED":
        return "unknown";
      case "TOOL_CODE":
      case "MALFORMED_FUNCTION_CALL":
        return "tool_use";
      default:
        return reason ? "unknown" : "end_turn";
    }
  }

  // ── Stream Processing ───────────────────────────────────────────────

  /**
   * Process a Gemini SSE stream, accumulating content blocks and tool
   * calls, invoking the delta callback for each chunk.
   *
   * Gemini uses standard SSE format with `data: <json>` lines.
   * Each chunk has the same structure as a full generateContent response
   * (with candidates, usageMetadata, etc.) but contains incremental parts.
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
    let stopReason: StopReason = "unknown";
    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    const toolCalls: ToolCall[] = [];
    const contentBlocks: ContentBlock[] = [];

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

          // Skip empty lines, comments, event type lines
          if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) {
            continue;
          }

          // Only process data lines
          if (!trimmed.startsWith("data:")) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          let chunk: GeminiStreamChunk;
          try {
            chunk = JSON.parse(jsonStr) as GeminiStreamChunk;
          } catch {
            continue; // Skip malformed JSON
          }

          // Process usage metadata
          if (chunk.usageMetadata) {
            usage = {
              promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
              completionTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
              totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
              cachedTokens: chunk.usageMetadata.cachedContentTokenCount,
            };
            onDelta({ usage });
          }

          // Process candidates
          if (chunk.candidates) {
            const candidate = chunk.candidates[0];
            if (!candidate) continue;

            // Update finish reason
            if (candidate.finishReason) {
              stopReason = this.mapFinishReason(candidate.finishReason);
              onDelta({ stopReason });
            }

            // Process parts
            if (candidate.content?.parts) {
              for (const part of candidate.content.parts) {
                if ("text" in part) {
                  accumulatedText += part.text;
                  onDelta({ text: part.text });
                } else if ("functionCall" in part) {
                  const id = this.generateToolUseId();

                  toolCalls.push({
                    id,
                    name: part.functionCall.name,
                    input: part.functionCall.args ?? {},
                  });

                  onDelta({
                    toolUse: {
                      id,
                      name: part.functionCall.name,
                      inputDelta: JSON.stringify(part.functionCall.args ?? {}),
                    },
                  });
                }
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // ── Finalize accumulated content ──────────────────────────────────

    // Add text content block
    if (accumulatedText) {
      const textBlock: TextContent = {
        type: "text",
        text: accumulatedText,
      };
      contentBlocks.push(textBlock);
    }

    // Add tool call content blocks
    for (const tc of toolCalls) {
      const toolUseBlock: ToolUseContent = {
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.input,
      };
      contentBlocks.push(toolUseBlock);
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
   * Handle a non-OK HTTP response from the Gemini API.
   */
  private async handleErrorResponse(
    response: Response,
    durationMs: number
  ): Promise<ChatCompletionResponse> {
    const errorBody = await response.text().catch(() => "");
    let errorMessage = `HTTP ${response.status} ${response.statusText}`;

    try {
      const parsed = JSON.parse(errorBody) as GeminiErrorResponse;
      if (parsed?.error?.message) {
        errorMessage = `${parsed.error.status ?? parsed.error.code}: ${parsed.error.message}`;
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
 * Create a new Google Gemini provider instance.
 *
 * This is the factory function registered with the provider registry.
 * It follows the ProviderFactory signature: (apiKey, baseUrl) => BaseProvider.
 *
 * @param apiKey  - Google Gemini API key (from AI Studio or Cloud Console).
 * @param baseUrl - Base URL for the Gemini API
 *                  (default: https://generativelanguage.googleapis.com).
 * @returns A configured GeminiProvider instance.
 */
export function createProvider(apiKey: string, baseUrl: string): BaseProvider {
  return new GeminiProvider(apiKey, baseUrl);
}
