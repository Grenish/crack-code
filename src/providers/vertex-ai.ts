// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Google Vertex AI Provider
// ─────────────────────────────────────────────────────────────────────────────
// Concrete implementation of BaseProvider for Google's Vertex AI platform.
//
// Vertex AI serves the same Gemini models as the AI Studio / Generative
// Language API, but uses a different authentication scheme and URL structure:
//
//   Auth:      Bearer access token (from `gcloud auth print-access-token`
//              or a service account key) instead of API-key query parameter.
//
//   Endpoint:  POST https://{REGION}-aiplatform.googleapis.com/v1/
//              projects/{PROJECT}/locations/{REGION}/publishers/google/
//              models/{MODEL}:generateContent
//
//   Streaming: POST …/models/{MODEL}:streamGenerateContent?alt=sse
//
//   Models:    GET  https://{REGION}-aiplatform.googleapis.com/v1/
//              publishers/google/models
//
// The request/response payload format is identical to the Gemini API, so
// all transformation and parsing logic mirrors the Gemini provider.
//
// Configuration:
//   apiKey  → Bearer access token
//   baseUrl → https://{REGION}-aiplatform.googleapis.com  (region-scoped)
//
// Environment variables:
//   VERTEX_AI_ACCESS_TOKEN  — access token
//   GOOGLE_CLOUD_PROJECT    — GCP project ID
//   GOOGLE_CLOUD_REGION     — GCP region (default: us-central1)
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

import {
  AI_PROVIDER,
  AI_PROVIDER_LABELS,
  AI_PROVIDER_ENV_KEYS,
  HTTP_TIMEOUT_MS,
} from "../utils/constants.js";

// ── Gemini / Vertex AI Wire-Format Types ────────────────────────────────────
// The Vertex AI API uses the exact same payload schema as the public
// Gemini API — these types are duplicated here to keep the provider
// self-contained (the Gemini provider does not export its internal types).

interface VertexTextPart {
  text: string;
}

interface VertexFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

interface VertexFunctionResponsePart {
  functionResponse: {
    name: string;
    response: {
      name: string;
      content: unknown;
    };
  };
}

type VertexPart =
  | VertexTextPart
  | VertexFunctionCallPart
  | VertexFunctionResponsePart;

interface VertexContent {
  role: "user" | "model";
  parts: VertexPart[];
}

interface VertexSystemInstruction {
  parts: VertexTextPart[];
}

interface VertexFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface VertexToolDef {
  functionDeclarations: VertexFunctionDeclaration[];
}

interface VertexGenerationConfig {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
}

interface VertexGenerateRequest {
  contents: VertexContent[];
  systemInstruction?: VertexSystemInstruction;
  tools?: VertexToolDef[];
  generationConfig?: VertexGenerationConfig;
}

interface VertexCandidate {
  content: {
    role: "model";
    parts: VertexPart[];
  };
  finishReason: string | null;
  index: number;
  safetyRatings?: Array<{
    category: string;
    probability: string;
    blocked?: boolean;
  }>;
}

interface VertexUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  cachedContentTokenCount?: number;
}

interface VertexGenerateResponse {
  candidates: VertexCandidate[];
  usageMetadata?: VertexUsageMetadata;
  modelVersion?: string;
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: Array<{
      category: string;
      probability: string;
    }>;
  };
}

interface VertexErrorResponse {
  error?: {
    code: number;
    message: string;
    status: string;
    details?: unknown[];
  };
}

interface VertexStreamChunk {
  candidates?: VertexCandidate[];
  usageMetadata?: VertexUsageMetadata;
  modelVersion?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

const DEFAULT_REGION = "us-central1";

// ── Vertex AI Provider Implementation ───────────────────────────────────────

class VertexAIProvider extends BaseProvider {
  /** GCP project ID (resolved lazily from env or baseUrl). */
  private projectId: string = "";

  /** GCP region/location (resolved lazily from baseUrl or env). */
  private region: string = DEFAULT_REGION;

  constructor(apiKey: string, baseUrl: string) {
    super(apiKey, baseUrl);
    this.resolveProjectAndRegion();
  }

  // ── Provider Info ───────────────────────────────────────────────────

  getInfo(): ProviderInfo {
    return {
      id: AI_PROVIDER.VERTEX_AI,
      label: AI_PROVIDER_LABELS[AI_PROVIDER.VERTEX_AI],
      baseUrl: this.baseUrl,
      isLocal: false,
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: true,
      maxContextTokens: 1_000_000,
      envKeyName: AI_PROVIDER_ENV_KEYS[AI_PROVIDER.VERTEX_AI],
    };
  }

  // ── Model Discovery ─────────────────────────────────────────────────

  async listModels(): Promise<ModelFetchResult> {
    const match = this.baseUrl.match(/^(https?:\/\/[^\/]+)/);
    const domain = match ? match[1] : this.baseUrl.replace(/\/+$/, "");

    let fetchUrl = this.baseUrl;
    if (this.projectId && !this.baseUrl.includes("/projects/")) {
      fetchUrl = `${domain}/v1/projects/${encodeURIComponent(this.projectId)}/locations/${encodeURIComponent(this.region)}`;
    }

    return fetchModels(AI_PROVIDER.VERTEX_AI, this.apiKey, fetchUrl);
  }

  // ── Health Check ────────────────────────────────────────────────────

  async healthCheck(): Promise<ProviderHealthCheck> {
    const start = performance.now();

    try {
      const result = await this.listModels();
      const latencyMs = performance.now() - start;

      if (!result.ok) {
        let error = result.error ?? "Unknown error";

        // Provide helpful hints for common issues
        if (error.includes("401") || error.includes("403")) {
          error +=
            "\n  Hint: Your access token may have expired. " +
            "Refresh it with: gcloud auth print-access-token";
        } else if (
          error.includes("ENOTFOUND") ||
          error.includes("ECONNREFUSED")
        ) {
          error +=
            "\n  Hint: Check that GOOGLE_CLOUD_REGION is set correctly " +
            "and the Vertex AI API is enabled in your GCP project.";
        }

        return {
          healthy: false,
          latencyMs,
          error,
          modelCount: 0,
        };
      }

      const models = result.allModels;
      const toolModels = result.toolCallingModels;

      if (models.length === 0) {
        return {
          healthy: true,
          latencyMs,
          error:
            "Connected but no models found. " +
            "Ensure the Vertex AI API is enabled in your project.",
          modelCount: 0,
        };
      }

      // Cache the models
      this.cachedModels = models;

      return {
        healthy: true,
        modelCount: models.length,
        latencyMs,
        metadata: {
          toolCallingModels: toolModels.length,
          totalModels: models.length,
          region: this.region,
          projectId: this.projectId || "(not set)",
        },
      };
    } catch (err) {
      const latencyMs = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      let friendlyMessage = `Vertex AI health check failed: ${message}`;

      if (message.includes("fetch")) {
        friendlyMessage +=
          "\n  Ensure the Vertex AI API is enabled and the region is correct.";
      }

      return {
        healthy: false,
        error: friendlyMessage,
        latencyMs,
        modelCount: 0,
      };
    }
  }

  // ── Chat Completion ─────────────────────────────────────────────────

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const start = performance.now();

    try {
      const model = this.resolveModelId(request.model || this.selectedModel);
      if (!model) {
        return this.buildErrorResponse(
          "No model specified. Set a model via configuration or pass it in the request.",
          undefined,
          0,
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

      const data = (await response.json()) as VertexGenerateResponse;
      return this.parseResponse(data, model, durationMs);
    } catch (err) {
      return this.handleFetchError(err, start);
    }
  }

  // ── Streaming Chat Completion ───────────────────────────────────────

  async chatStream(
    request: StreamingChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const start = performance.now();

    try {
      const model = this.resolveModelId(request.model || this.selectedModel);
      if (!model) {
        return this.buildErrorResponse(
          "No model specified. Set a model via configuration or pass it in the request.",
          undefined,
          0,
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
          durationMs,
        );
      }

      return await this.processStream(
        response.body,
        request.onDelta,
        model,
        start,
      );
    } catch (err) {
      return this.handleFetchError(err, start);
    }
  }

  // ── Project / Region Resolution ─────────────────────────────────────

  /**
   * Resolve the GCP project ID and region from:
   *   1. The base URL (if it encodes `projects/{id}/locations/{region}`)
   *   2. Environment variables (GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_REGION)
   *   3. Reasonable defaults
   */
  private resolveProjectAndRegion(): void {
    const env =
      typeof process !== "undefined"
        ? process.env
        : ({} as Record<string, string | undefined>);

    // Try to extract region from the base URL
    // e.g. https://us-central1-aiplatform.googleapis.com
    const regionMatch = this.baseUrl.match(
      /^https?:\/\/([a-z0-9-]+)-aiplatform\.googleapis\.com/i,
    );
    if (regionMatch) {
      this.region = regionMatch[1]!;
    } else {
      this.region = env["GOOGLE_CLOUD_REGION"] ?? DEFAULT_REGION;
    }

    // Try to extract project from the base URL
    // e.g. .../projects/my-project/locations/...
    const projectMatch = this.baseUrl.match(/\/projects\/([^/]+)(?:\/|$)/);
    if (projectMatch) {
      this.projectId = projectMatch[1]!;
    } else {
      this.projectId =
        env["GOOGLE_CLOUD_PROJECT"] ?? env["GCLOUD_PROJECT"] ?? "";
    }

    // Normalize the base URL to just the regional endpoint
    // (strip any path components that were used to encode project/region)
    if (this.baseUrl && !this.baseUrl.includes("aiplatform.googleapis.com")) {
      // User may have provided just the region name
      this.baseUrl = `https://${this.region}-aiplatform.googleapis.com`;
    } else if (!this.baseUrl) {
      this.baseUrl = `https://${this.region}-aiplatform.googleapis.com`;
    }

    // Ensure trailing slashes are stripped
    this.baseUrl = this.baseUrl.replace(/\/+$/, "");
  }

  /**
   * Resolve a model identifier.
   *
   * Vertex AI models returned from the listing endpoint come as fully
   * qualified names like `publishers/google/models/gemini-2.0-flash`.
   * For the generateContent URL we need just the short ID (e.g.
   * `gemini-2.0-flash`).
   */
  private resolveModelId(model: string): string {
    if (!model) return "";

    // Strip the publisher prefix if present
    const prefix = "publishers/google/models/";
    if (model.startsWith(prefix)) {
      return model.slice(prefix.length);
    }

    // Strip "models/" prefix (Gemini API format)
    if (model.startsWith("models/")) {
      return model.slice("models/".length);
    }

    return model;
  }

  // ── URL Building ────────────────────────────────────────────────────

  /**
   * Build the generateContent endpoint URL for Vertex AI.
   *
   * If a project ID is available:
   *   POST /v1/projects/{PROJECT}/locations/{REGION}/publishers/google/models/{MODEL}:generateContent
   *
   * If no project ID (fallback — uses the v1beta publisher endpoint):
   *   POST /v1beta1/publishers/google/models/{MODEL}:generateContent?key={API_KEY}
   *   (Note: this fallback is unlikely to work for Vertex AI; a project is required)
   */
  private buildGenerateUrl(model: string): string {
    const match = this.baseUrl.match(/^(https?:\/\/[^\/]+)/);
    const domain = match ? match[1] : this.baseUrl.replace(/\/+$/, "");

    if (this.projectId) {
      return (
        `${domain}/v1/projects/${encodeURIComponent(this.projectId)}` +
        `/locations/${encodeURIComponent(this.region)}` +
        `/publishers/google/models/${encodeURIComponent(model)}:generateContent`
      );
    }

    // Fallback: publisher-level endpoint (requires project in most cases)
    return `${domain}/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
  }

  /**
   * Build the streaming endpoint URL for Vertex AI.
   */
  private buildStreamUrl(model: string): string {
    const match = this.baseUrl.match(/^(https?:\/\/[^\/]+)/);
    const domain = match ? match[1] : this.baseUrl.replace(/\/+$/, "");

    if (this.projectId) {
      return (
        `${domain}/v1/projects/${encodeURIComponent(this.projectId)}` +
        `/locations/${encodeURIComponent(this.region)}` +
        `/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
      );
    }

    return `${domain}/v1/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  }

  // ── Request Building ────────────────────────────────────────────────

  /**
   * Build HTTP headers for Vertex AI requests.
   *
   * Unlike the public Gemini API (which uses query-parameter auth),
   * Vertex AI uses a standard Bearer token in the Authorization header.
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  /**
   * Transform our unified ChatCompletionRequest into the Vertex AI
   * generateContent request body format.
   *
   * The payload schema is identical to the Gemini API.
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
  ): VertexGenerateRequest {
    const contents = this.transformMessages(request.messages);

    const body: VertexGenerateRequest = {
      contents,
    };

    // System instruction
    const systemPrompt =
      request.systemPrompt ?? this.extractSystemPrompt(request.messages);
    if (systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: systemPrompt }],
      };
    }

    // Generation configuration
    const generationConfig: VertexGenerationConfig = {};
    let hasConfig = false;

    if (request.temperature !== undefined) {
      generationConfig.temperature = Math.max(
        0,
        Math.min(2, request.temperature),
      );
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
            this.transformToolDefinition(tool),
          ),
        },
      ];
    }

    return body;
  }

  // ── Message Transformation ──────────────────────────────────────────

  /**
   * Transform our unified ChatMessage[] into Vertex AI's contents format.
   *
   * Vertex AI (like Gemini) requires strict alternation between "user"
   * and "model" roles. Consecutive same-role messages are merged into
   * a single content entry.
   */
  private transformMessages(messages: ChatMessage[]): VertexContent[] {
    const result: VertexContent[] = [];

    for (const msg of messages) {
      // System messages are handled separately via systemInstruction
      if (msg.role === "system") continue;

      if (msg.role === "tool") {
        // Tool results become user messages with functionResponse parts
        const toolName = msg.name ?? "unknown_tool";
        const responseContent =
          typeof msg.content === "string"
            ? msg.content
            : this.flattenMessageContent(msg);

        let parsedContent: unknown;
        try {
          parsedContent = JSON.parse(responseContent);
        } catch {
          parsedContent = { result: responseContent };
        }

        const part: VertexFunctionResponsePart = {
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

      const vertexRole: "user" | "model" =
        msg.role === "assistant" ? "model" : "user";
      const parts = this.messageContentToParts(msg);

      if (parts.length === 0) continue;

      // Merge consecutive same-role messages
      const lastMsg = result[result.length - 1];
      if (lastMsg && lastMsg.role === vertexRole) {
        lastMsg.parts.push(...parts);
      } else {
        result.push({
          role: vertexRole,
          parts,
        });
      }
    }

    // Vertex AI requires the conversation to start with a "user" role
    if (result.length > 0 && result[0]!.role !== "user") {
      result.unshift({
        role: "user",
        parts: [{ text: "Hello." }],
      });
    }

    // Ensure strict user/model alternation by inserting placeholder messages
    const fixed: VertexContent[] = [];
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
   * Convert a ChatMessage's content into an array of Vertex AI parts.
   */
  private messageContentToParts(msg: ChatMessage): VertexPart[] {
    if (typeof msg.content === "string") {
      if (!msg.content.trim()) return [];
      return [{ text: msg.content }];
    }

    const parts: VertexPart[] = [];

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
        typeof m.content === "string"
          ? m.content
          : this.flattenMessageContent(m),
      )
      .join("\n\n");
  }

  /**
   * Transform our unified ToolDefinition into the Vertex AI function
   * declaration format.
   */
  private transformToolDefinition(
    tool: ToolDefinition,
  ): VertexFunctionDeclaration {
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
   * Parse a Vertex AI generateContent response into our unified format.
   */
  private parseResponse(
    data: VertexGenerateResponse,
    model: string,
    durationMs: number,
  ): ChatCompletionResponse {
    // Check for prompt feedback blocking
    if (data.promptFeedback?.blockReason) {
      return this.buildErrorResponse(
        `Request blocked by safety filter: ${data.promptFeedback.blockReason}`,
        400,
        durationMs,
      );
    }

    const candidate = data.candidates?.[0];
    if (!candidate) {
      return this.buildErrorResponse(
        "No candidates returned in the response",
        undefined,
        durationMs,
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
   * Map Vertex AI's finishReason string to our unified StopReason.
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
   * Process a Vertex AI SSE stream, accumulating content blocks and tool
   * calls, invoking the delta callback for each chunk.
   *
   * Vertex AI uses the same SSE format as the Gemini API:
   * `data: <json>` lines with identical candidate/usage structure.
   */
  private async processStream(
    body: ReadableStream<Uint8Array>,
    onDelta: (delta: StreamDelta) => void,
    model: string,
    startTime: number,
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

          let chunk: VertexStreamChunk;
          try {
            chunk = JSON.parse(jsonStr) as VertexStreamChunk;
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

    if (accumulatedText) {
      const textBlock: TextContent = {
        type: "text",
        text: accumulatedText,
      };
      contentBlocks.push(textBlock);
    }

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
   * Handle a non-OK HTTP response from the Vertex AI API.
   */
  private async handleErrorResponse(
    response: Response,
    durationMs: number,
  ): Promise<ChatCompletionResponse> {
    const errorBody = await response.text().catch(() => "");
    let errorMessage = `HTTP ${response.status} ${response.statusText}`;

    try {
      const parsed = JSON.parse(errorBody) as VertexErrorResponse;
      if (parsed?.error?.message) {
        errorMessage = `${parsed.error.status ?? parsed.error.code}: ${parsed.error.message}`;
      }
    } catch {
      if (errorBody) {
        errorMessage += `: ${errorBody.slice(0, 300)}`;
      }
    }

    // Add helpful context for common Vertex AI errors
    if (response.status === 401 || response.status === 403) {
      errorMessage +=
        "\n  Your access token may have expired or lacks the required IAM permissions." +
        "\n  Refresh with: gcloud auth print-access-token" +
        "\n  Required role: roles/aiplatform.user";
    } else if (response.status === 404) {
      errorMessage +=
        `\n  Check that GOOGLE_CLOUD_PROJECT (${this.projectId || "not set"})` +
        ` and GOOGLE_CLOUD_REGION (${this.region}) are correct,` +
        " and that the Vertex AI API is enabled.";
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

// ── Factory Function ────────────────────────────────────────────────────────

/**
 * Create a new Google Vertex AI provider instance.
 *
 * This is the factory function registered with the provider registry.
 * It follows the ProviderFactory signature: (apiKey, baseUrl) => BaseProvider.
 *
 * @param apiKey  - Google Cloud access token (from `gcloud auth print-access-token`
 *                  or a service account). Set via VERTEX_AI_ACCESS_TOKEN env var.
 * @param baseUrl - Regional Vertex AI endpoint, e.g.
 *                  `https://us-central1-aiplatform.googleapis.com`.
 *                  The region is extracted from this URL automatically.
 *                  Project ID comes from GOOGLE_CLOUD_PROJECT env var.
 * @returns A configured VertexAIProvider instance.
 */
export function createProvider(apiKey: string, baseUrl: string): BaseProvider {
  return new VertexAIProvider(apiKey, baseUrl);
}
