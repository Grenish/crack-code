// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Alibaba Qwen Provider (DashScope Compatible Mode)
// ─────────────────────────────────────────────────────────────────────────────
// Concrete implementation extending the OpenAI-compatible base provider
// for Alibaba Cloud's Qwen models via the DashScope compatible-mode API.
//
// DashScope offers an OpenAI-compatible endpoint at:
//   https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
//
// This means the request/response format is identical to OpenAI's Chat
// Completions API — the only differences are:
//   1. Base URL points to DashScope instead of OpenAI
//   2. The chat completions path is /compatible-mode/v1/chat/completions
//   3. Model listing is at /compatible-mode/v1/models
//   4. API key comes from DASHSCOPE_API_KEY environment variable
//
// Models are fetched dynamically from the DashScope models endpoint at
// runtime — nothing is hardcoded. The response follows the OpenAI format
// with { data: [{ id, object, owned_by }] }, and all returned models
// are treated as tool-calling capable since DashScope's compatible mode
// fully supports the OpenAI function/tool calling contract.
//
// Zero external dependencies — uses the built-in fetch API exclusively.
// ─────────────────────────────────────────────────────────────────────────────

import { OpenAICompatibleProvider } from "./openai-compatible.js";

import {
  type ProviderInfo,
  type ProviderHealthCheck,
  type BaseProvider,
} from "./base.js";

import {
  fetchModels,
  type ModelFetchResult,
  type DiscoveredModel,
} from "./model-fetcher.js";

import {
  AI_PROVIDER,
  AI_PROVIDER_LABELS,
  AI_PROVIDER_ENV_KEYS,
} from "../utils/constants.js";

// ── Model Filtering ─────────────────────────────────────────────────────────
// DashScope's compatible-mode /v1/models endpoint returns a wide range of
// models including embedding, audio, vision-only, and legacy variants.
// We filter to only include Qwen chat models that are relevant for
// security analysis with tool-calling support.

const CHAT_MODEL_PREFIXES = [
  "qwen-",
  "qwen1",
  "qwen2",
  "qwen3",
  "qwq-",
] as const;

// Models or patterns to explicitly exclude from the selection list
const EXCLUDE_PATTERNS: RegExp[] = [
  /embed/i,
  /audio/i,
  /vl-ocr/i,
  /rerank/i,
  /speech/i,
  /paraformer/i,
  /sambert/i,
  /cosyvoice/i,
  /farui/i,
  /wanx/i,
  /flux/i,
];

// ── Qwen Provider Implementation ────────────────────────────────────────────

class QwenProvider extends OpenAICompatibleProvider {
  protected readonly providerId = AI_PROVIDER.QWEN;

  constructor(apiKey: string, baseUrl: string) {
    super(apiKey, baseUrl);
  }

  // ── Provider Info ───────────────────────────────────────────────────

  getInfo(): ProviderInfo {
    return {
      id: AI_PROVIDER.QWEN,
      label: AI_PROVIDER_LABELS[AI_PROVIDER.QWEN],
      baseUrl: this.baseUrl,
      isLocal: false,
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: true,
      maxContextTokens: 131_072, // Qwen-Long supports up to 1M, but 128K is typical
      envKeyName: AI_PROVIDER_ENV_KEYS[AI_PROVIDER.QWEN],
    };
  }

  // ── Chat Endpoint Override ──────────────────────────────────────────

  /**
   * Override the chat endpoint to use DashScope's compatible-mode path.
   *
   * DashScope's OpenAI-compatible endpoint is at:
   *   /compatible-mode/v1/chat/completions
   *
   * instead of the standard OpenAI path:
   *   /v1/chat/completions
   */
  protected override getChatEndpoint(): string {
    return `${this.baseUrl}/compatible-mode/v1/chat/completions`;
  }

  // ── Model Discovery (with chat-model filtering) ─────────────────────

  /**
   * Fetch models from the DashScope compatible-mode API and filter to
   * only chat-relevant Qwen models that support tool/function calling.
   *
   * DashScope's /compatible-mode/v1/models endpoint returns models across
   * all product lines (text, embedding, audio, image generation, etc.).
   * We filter to only surface Qwen chat/reasoning models, excluding
   * embedding, audio, OCR, and image generation variants.
   *
   * The filtering uses a two-pass approach:
   * 1. Inclusion: model ID must start with a known Qwen chat prefix
   * 2. Exclusion: model ID must NOT match any exclusion patterns
   *
   * This ensures new Qwen model releases are automatically included
   * while non-chat models are kept out of the selection menu.
   */
  override async listModels(): Promise<ModelFetchResult> {
    const result = await fetchModels(
      AI_PROVIDER.QWEN,
      this.apiKey,
      this.baseUrl,
    );

    if (!result.ok) return result;

    // Filter to only chat-completion-relevant models
    const filteredAll = result.allModels.filter(isQwenChatModel);
    const filteredToolCalling =
      result.toolCallingModels.filter(isQwenChatModel);

    // If filtering removed everything (e.g. custom endpoint with different
    // model naming), fall back to showing all returned models
    if (filteredAll.length === 0 && result.allModels.length > 0) {
      this.cachedModels =
        result.toolCallingModels.length > 0
          ? result.toolCallingModels
          : result.allModels;

      return result;
    }

    // Update the cached models on this instance
    this.cachedModels =
      filteredToolCalling.length > 0 ? filteredToolCalling : filteredAll;

    return {
      ...result,
      allModels: filteredAll,
      toolCallingModels: filteredToolCalling,
    };
  }

  // ── Health Check (with DashScope-specific error messages) ───────────

  override async healthCheck(): Promise<ProviderHealthCheck> {
    const start = performance.now();

    try {
      const result = await this.listModels();
      const latencyMs = performance.now() - start;

      if (!result.ok) {
        let error = result.error ?? "Unknown error";

        if (
          error.includes("401") ||
          error.includes("Unauthorized") ||
          error.includes("InvalidApiKey")
        ) {
          error =
            "Invalid API key. Verify your DASHSCOPE_API_KEY is correct and has not been revoked. " +
            "You can manage your keys at https://dashscope.console.aliyun.com/credentials";
        } else if (
          error.includes("429") ||
          error.includes("Throttling") ||
          error.includes("rate")
        ) {
          error =
            "Rate limited by DashScope. Wait a moment and try again, or check your account quota " +
            "at https://dashscope.console.aliyun.com/";
        } else if (
          error.includes("403") ||
          error.includes("Forbidden") ||
          error.includes("NoPermission")
        ) {
          error =
            "API key does not have permission to access Qwen models. " +
            "Ensure your Alibaba Cloud account has DashScope service activated and the key has appropriate permissions.";
        } else if (error.includes("404")) {
          error =
            "DashScope compatible-mode endpoint not found. " +
            "Verify the base URL is correct (default: https://dashscope.aliyuncs.com).";
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
          totalModelsBeforeFilter: result.allModels.length,
          toolCallingModels: result.toolCallingModels.length,
        },
      };
    } catch (err) {
      const latencyMs = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      let friendlyMessage = `Connection failed: ${message}`;

      if (message.includes("fetch") || message.includes("ECONNREFUSED")) {
        friendlyMessage =
          "Cannot reach the DashScope API. Check your network connection and firewall settings. " +
          "If you are in mainland China, ensure direct connectivity to dashscope.aliyuncs.com.";
      } else if (
        message.includes("timeout") ||
        message.includes("TimeoutError")
      ) {
        friendlyMessage =
          "Connection to DashScope timed out. The API may be experiencing high load. " +
          "If you are outside China, latency may be higher than usual.";
      } else if (
        message.includes("ENOTFOUND") ||
        message.includes("getaddrinfo")
      ) {
        friendlyMessage =
          "DNS resolution failed for dashscope.aliyuncs.com. " +
          "Check your network connection and DNS settings.";
      }

      return {
        healthy: false,
        latencyMs,
        error: friendlyMessage,
        modelCount: 0,
      };
    }
  }

  // ── Headers Override ────────────────────────────────────────────────

  /**
   * Build HTTP headers for DashScope requests.
   *
   * DashScope's compatible-mode API uses standard Bearer token auth,
   * identical to OpenAI. We also include the X-DashScope-SSE header
   * for streaming compatibility and set the plugin to enable
   * enhanced features when available.
   */
  protected override buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    // DashScope-specific: enable SSE for streaming responses
    headers["X-DashScope-SSE"] = "enable";

    return headers;
  }
}

// ── Model Filtering Logic ───────────────────────────────────────────────────

/**
 * Determine whether a discovered model is a Qwen chat model suitable
 * for security analysis with tool calling.
 *
 * DashScope returns a broad catalog of models spanning multiple modalities:
 * - Text generation (qwen-max, qwen-plus, qwen-turbo, qwen3-*, qwq-*)
 * - Embedding (text-embedding-v1, text-embedding-v2, etc.)
 * - Audio (paraformer, cosyvoice, sambert, etc.)
 * - Image generation (wanx, flux, etc.)
 * - Vision-OCR (qwen-vl-ocr, etc.)
 * - Reranking (gte-rerank, etc.)
 * - Legal/specialized (farui, etc.)
 *
 * This function implements a two-pass filter:
 * 1. **Inclusion pass**: The model ID must start with one of the known
 *    Qwen chat model prefixes (qwen-, qwen1*, qwen2*, qwen3*, qwq-*).
 * 2. **Exclusion pass**: The model ID must NOT match any of the explicit
 *    exclude patterns (embed, audio, ocr, rerank, speech, image, etc.).
 *
 * This approach is resilient to new model releases — any new Qwen chat
 * model will be automatically included as long as it follows the standard
 * naming convention. Models with unfamiliar naming are excluded by default,
 * but the entire unfiltered list is preserved as a fallback if filtering
 * removes everything (e.g. when using a custom DashScope-compatible
 * endpoint with differently named models).
 */
function isQwenChatModel(model: DiscoveredModel): boolean {
  const id = model.id.toLowerCase();

  // ── Inclusion check ─────────────────────────────────────────────────
  const matchesPrefix = CHAT_MODEL_PREFIXES.some((prefix) =>
    id.startsWith(prefix),
  );

  if (!matchesPrefix) return false;

  // ── Exclusion check ─────────────────────────────────────────────────
  for (const pattern of EXCLUDE_PATTERNS) {
    if (pattern.test(model.id)) return false;
  }

  return true;
}

// ── Factory Function ────────────────────────────────────────────────────────

/**
 * Create a new Alibaba Qwen provider instance.
 *
 * This is the factory function registered with the provider registry.
 * It follows the ProviderFactory signature: (apiKey, baseUrl) => BaseProvider.
 *
 * @param apiKey  - DashScope API key (from Alibaba Cloud console).
 *                  Environment variable: DASHSCOPE_API_KEY
 * @param baseUrl - Base URL for the DashScope API
 *                  (default: https://dashscope.aliyuncs.com).
 *                  The compatible-mode prefix (/compatible-mode/v1) is
 *                  appended automatically by the endpoint methods.
 * @returns A configured QwenProvider instance.
 */
export function createProvider(apiKey: string, baseUrl: string): BaseProvider {
  return new QwenProvider(apiKey, baseUrl);
}
