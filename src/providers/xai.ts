// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — xAI Grok Provider
// ─────────────────────────────────────────────────────────────────────────────
// Concrete implementation extending the OpenAI-compatible base provider
// for xAI's Grok models. xAI fully implements the OpenAI Chat Completions
// API contract, so this provider only needs to override metadata and
// model discovery — all request/response handling is inherited.
//
// Models are fetched dynamically from the xAI /v1/models endpoint at
// runtime — nothing is hardcoded. All returned models are treated as
// tool-calling capable since xAI's API is fully OpenAI-compatible.
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
// xAI's /v1/models endpoint may return embedding or moderation models
// alongside chat models. We filter to only include chat-relevant models
// (those with "grok" in the name) to keep the selection menu clean.

const CHAT_MODEL_PREFIXES = ["grok"] as const;

// Models or patterns to exclude from the selection list
const EXCLUDE_PATTERNS: RegExp[] = [/embed/i, /moderation/i, /image/i];

// ── xAI Provider Implementation ─────────────────────────────────────────────

class XAIProvider extends OpenAICompatibleProvider {
  protected readonly providerId = AI_PROVIDER.XAI;

  constructor(apiKey: string, baseUrl: string) {
    super(apiKey, baseUrl);
  }

  // ── Provider Info ───────────────────────────────────────────────────

  override getInfo(): ProviderInfo {
    return {
      id: AI_PROVIDER.XAI,
      label: AI_PROVIDER_LABELS[AI_PROVIDER.XAI],
      baseUrl: this.baseUrl,
      isLocal: false,
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: true,
      maxContextTokens: 131_072,
      envKeyName: AI_PROVIDER_ENV_KEYS[AI_PROVIDER.XAI],
    };
  }

  // ── Model Discovery (with chat-model filtering) ─────────────────────

  /**
   * Fetch models from the xAI API and filter to only chat-relevant
   * Grok models that support tool/function calling.
   *
   * xAI's /v1/models endpoint follows the OpenAI contract exactly,
   * returning { data: [{ id, object, owned_by }] }. We filter to
   * only surface Grok chat models, excluding embedding or moderation
   * variants if any are returned.
   */
  override async listModels(): Promise<ModelFetchResult> {
    const result = await fetchModels(
      AI_PROVIDER.XAI,
      this.apiKey,
      this.baseUrl,
    );

    if (!result.ok) return result;

    // Filter to only chat-completion-relevant models
    const filteredAll = result.allModels.filter(isGrokChatModel);
    const filteredToolCalling =
      result.toolCallingModels.filter(isGrokChatModel);

    // Update the cached models on this instance
    this.cachedModels =
      filteredToolCalling.length > 0 ? filteredToolCalling : filteredAll;

    return {
      ...result,
      allModels: filteredAll,
      toolCallingModels: filteredToolCalling,
    };
  }

  // ── Health Check (with xAI-specific error messages) ─────────────────

  override async healthCheck(): Promise<ProviderHealthCheck> {
    const start = performance.now();

    try {
      const result = await this.listModels();
      const latencyMs = performance.now() - start;

      if (!result.ok) {
        let error = result.error ?? "Unknown error";

        if (error.includes("401") || error.includes("Unauthorized")) {
          error =
            "Invalid API key. Verify your XAI_API_KEY is correct and has not been revoked. " +
            "You can manage your keys at https://console.x.ai/";
        } else if (error.includes("429") || error.includes("Rate limit")) {
          error =
            "Rate limited by xAI. Wait a moment and try again, or check your account quota.";
        } else if (error.includes("403") || error.includes("Forbidden")) {
          error =
            "API key does not have permission to list models. Check your xAI account permissions.";
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
          "Cannot reach the xAI API. Check your network connection and firewall settings.";
      } else if (
        message.includes("timeout") ||
        message.includes("TimeoutError")
      ) {
        friendlyMessage =
          "Connection to xAI timed out. The API may be experiencing high load.";
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
 * Determine whether a discovered model is a Grok chat model suitable
 * for security analysis with tool calling.
 *
 * This function:
 * 1. Checks if the model ID starts with a known chat model prefix ("grok").
 * 2. Excludes models matching any exclusion patterns (embedding, moderation, image).
 *
 * If xAI releases new Grok variants, they will be automatically included
 * as long as they start with "grok" and don't match an exclusion pattern.
 * If the endpoint returns no models matching "grok", we fall back to
 * returning all models (the user may be using a custom xAI-compatible
 * endpoint with differently named models).
 */
function isGrokChatModel(model: DiscoveredModel): boolean {
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
 * Create a new xAI (Grok) provider instance.
 *
 * This is the factory function registered with the provider registry.
 * It follows the ProviderFactory signature: (apiKey, baseUrl) => BaseProvider.
 *
 * @param apiKey  - xAI API key.
 * @param baseUrl - Base URL for the xAI API
 *                  (default: https://api.x.ai).
 * @returns A configured XAIProvider instance.
 */
export function createProvider(apiKey: string, baseUrl: string): BaseProvider {
  return new XAIProvider(apiKey, baseUrl);
}
