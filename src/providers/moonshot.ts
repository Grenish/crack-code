// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Moonshot Kimi Provider
// ─────────────────────────────────────────────────────────────────────────────
// Concrete implementation extending the OpenAI-compatible base provider
// for Moonshot AI's Kimi models. Moonshot fully implements the OpenAI Chat
// Completions API contract, so this provider only needs to override
// metadata, model discovery filtering, and endpoint configuration — all
// request/response handling is inherited from the shared base.
//
// Key details:
// - Base URL: https://api.moonshot.cn
// - Auth: Bearer token (standard OpenAI-compatible)
// - Chat endpoint: /v1/chat/completions (standard path)
// - Model listing: /v1/models (standard path)
// - Models returned: moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k,
//   kimi-latest, and potentially others — all fetched dynamically at
//   runtime from the API. Nothing is hardcoded.
// - All returned chat models support tool/function calling.
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
// Moonshot's /v1/models endpoint may return models across different product
// lines (chat, embedding, file extraction, etc.). We filter to only
// include chat-relevant models that are suitable for security analysis
// with tool-calling support.
//
// Known model families:
// - moonshot-v1-*   → chat models with varying context windows (8k/32k/128k)
// - kimi-*          → Kimi-branded chat models
// - moonshot-v2-*   → potential future generation models
//
// Embedding and utility models (if any) are excluded via pattern matching.

const CHAT_MODEL_PREFIXES = ["moonshot-v1", "moonshot-v2", "kimi"] as const;

// Models or patterns to explicitly exclude from the selection list
const EXCLUDE_PATTERNS: RegExp[] = [
  /embed/i,
  /rerank/i,
  /moderation/i,
  /file/i,
  /extract/i,
  /tokenizer/i,
];

// ── Moonshot Provider Implementation ────────────────────────────────────────

class MoonshotProvider extends OpenAICompatibleProvider {
  protected readonly providerId = AI_PROVIDER.MOONSHOT;

  constructor(apiKey: string, baseUrl: string) {
    super(apiKey, baseUrl);
  }

  // ── Provider Info ───────────────────────────────────────────────────

  override getInfo(): ProviderInfo {
    return {
      id: AI_PROVIDER.MOONSHOT,
      label: AI_PROVIDER_LABELS[AI_PROVIDER.MOONSHOT],
      baseUrl: this.baseUrl,
      isLocal: false,
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: false, // Moonshot Kimi chat models are text-only as of now
      maxContextTokens: 128_000, // moonshot-v1-128k supports up to 128K tokens
      envKeyName: AI_PROVIDER_ENV_KEYS[AI_PROVIDER.MOONSHOT],
    };
  }

  // ── Model Discovery (with chat-model filtering) ─────────────────────

  /**
   * Fetch models from the Moonshot API and filter to only chat-relevant
   * models that support tool/function calling.
   *
   * Moonshot's /v1/models endpoint follows the OpenAI contract exactly,
   * returning { data: [{ id, object, owned_by }] }. We filter to
   * only surface chat models (moonshot-v1-*, kimi-*), excluding any
   * embedding, extraction, or utility model variants if they appear.
   *
   * The filtering uses a two-pass approach:
   * 1. Inclusion: model ID must start with a known chat model prefix
   * 2. Exclusion: model ID must NOT match any exclusion patterns
   *
   * If filtering removes everything (e.g. custom endpoint with different
   * model naming), we fall back to returning all models from the API.
   */
  override async listModels(): Promise<ModelFetchResult> {
    const result = await fetchModels(
      AI_PROVIDER.MOONSHOT,
      this.apiKey,
      this.baseUrl,
    );

    if (!result.ok) return result;

    // Filter to only chat-completion-relevant models
    const filteredAll = result.allModels.filter(isMoonshotChatModel);
    const filteredToolCalling =
      result.toolCallingModels.filter(isMoonshotChatModel);

    // If filtering removed everything, fall back to showing all returned
    // models (the user may be using a custom Moonshot-compatible endpoint
    // with differently named models)
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

  // ── Health Check (with Moonshot-specific error messages) ────────────

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
          error.includes("auth")
        ) {
          error =
            "Invalid API key. Verify your MOONSHOT_API_KEY is correct and has not been revoked. " +
            "You can manage your keys at https://platform.moonshot.cn/console/api-keys";
        } else if (
          error.includes("429") ||
          error.includes("Rate limit") ||
          error.includes("rate")
        ) {
          error =
            "Rate limited by Moonshot. Wait a moment and try again, or check your account quota " +
            "at https://platform.moonshot.cn/console";
        } else if (error.includes("403") || error.includes("Forbidden")) {
          error =
            "API key does not have permission to access Moonshot models. " +
            "Check your account status and billing at https://platform.moonshot.cn/console";
        } else if (error.includes("404")) {
          error =
            "Moonshot API endpoint not found. Verify the base URL is correct " +
            "(default: https://api.moonshot.cn).";
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
          "Cannot reach the Moonshot API. Check your network connection and firewall settings. " +
          "If you are outside China, connectivity to api.moonshot.cn may be restricted or slow.";
      } else if (
        message.includes("timeout") ||
        message.includes("TimeoutError")
      ) {
        friendlyMessage =
          "Connection to Moonshot timed out. The API may be experiencing high load. " +
          "If you are outside China, consider using a VPN or proxy for better connectivity.";
      } else if (
        message.includes("ENOTFOUND") ||
        message.includes("getaddrinfo")
      ) {
        friendlyMessage =
          "DNS resolution failed for api.moonshot.cn. " +
          "Check your network connection and DNS settings. " +
          "The Moonshot API server may not be reachable from your current network.";
      } else if (
        message.includes("ECONNRESET") ||
        message.includes("socket hang up")
      ) {
        friendlyMessage =
          "Connection to Moonshot was reset. This may indicate a network issue, " +
          "firewall interference, or the API server rejecting the connection. " +
          "Try again in a moment.";
      }

      return {
        healthy: false,
        latencyMs,
        error: friendlyMessage,
        modelCount: 0,
      };
    }
  }
}

// ── Model Filtering Logic ───────────────────────────────────────────────────

/**
 * Determine whether a discovered model is a Moonshot chat model suitable
 * for security analysis with tool calling.
 *
 * Moonshot's model catalog is relatively focused (primarily chat models),
 * but may include utility or embedding models in the future. This function
 * implements a two-pass filter to ensure only chat-relevant models are
 * presented to the user:
 *
 * 1. **Inclusion pass**: The model ID must start with one of the known
 *    chat model prefixes (moonshot-v1*, moonshot-v2*, kimi*).
 * 2. **Exclusion pass**: The model ID must NOT match any of the explicit
 *    exclude patterns (embed, rerank, moderation, file, extract, etc.).
 *
 * This approach is resilient to new model releases — any new model
 * starting with a known prefix will be automatically included, while
 * clearly non-chat models are excluded by pattern.
 *
 * If no models match the filter (e.g. when using a custom endpoint with
 * non-standard model names), the caller falls back to showing all models
 * returned by the API.
 */
function isMoonshotChatModel(model: DiscoveredModel): boolean {
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
 * Create a new Moonshot Kimi provider instance.
 *
 * This is the factory function registered with the provider registry.
 * It follows the ProviderFactory signature: (apiKey, baseUrl) => BaseProvider.
 *
 * @param apiKey  - Moonshot API key (from https://platform.moonshot.cn/console/api-keys).
 *                  Environment variable: MOONSHOT_API_KEY
 * @param baseUrl - Base URL for the Moonshot API
 *                  (default: https://api.moonshot.cn).
 * @returns A configured MoonshotProvider instance.
 */
export function createProvider(apiKey: string, baseUrl: string): BaseProvider {
  return new MoonshotProvider(apiKey, baseUrl);
}
