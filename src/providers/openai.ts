// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — OpenAI ChatGPT Provider
// ─────────────────────────────────────────────────────────────────────────────
// Concrete implementation extending the OpenAI-compatible base provider.
// Adds OpenAI-specific metadata, model filtering (to exclude embeddings,
// whisper, dall-e, tts, and other non-chat models), and provider info.
//
// Models are fetched dynamically from the OpenAI /v1/models endpoint at
// runtime — nothing is hardcoded. The list is filtered to only include
// models relevant for chat completions with tool-calling support.
//
// Zero external dependencies — uses the built-in fetch API exclusively.
// ─────────────────────────────────────────────────────────────────────────────

import { OpenAICompatibleProvider } from "./openai-compatible.js";

import { type ProviderInfo, type ProviderHealthCheck } from "./base.js";

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

// ── Chat-Relevant Model Prefixes ────────────────────────────────────────────
// OpenAI's /v1/models endpoint returns everything — embeddings, audio,
// image generation, moderation, fine-tune snapshots, etc. We filter to
// only the model families that support chat completions + tool calling.

const CHAT_MODEL_PREFIXES = [
  "gpt-4",
  "gpt-3.5",
  "o1",
  "o3",
  "o4",
  "chatgpt",
] as const;

// ── Models / patterns to explicitly exclude ─────────────────────────────────
// Even within chat model families, some variants aren't useful for our
// purposes (e.g. base models without RLHF, instruct-only models that
// don't support tool calling, audio/realtime models, etc.)

const EXCLUDE_PATTERNS: RegExp[] = [
  /^gpt-4-base/i,
  /instruct/i,
  /audio/i,
  /realtime/i,
  /search/i,
  /^gpt-4-\d{4}$/i, // bare date suffixes like "gpt-4-0613" when the aliased version exists
];

// ── OpenAI Provider Implementation ──────────────────────────────────────────

class OpenAIProvider extends OpenAICompatibleProvider {
  protected readonly providerId = AI_PROVIDER.OPENAI;

  constructor(apiKey: string, baseUrl: string) {
    super(apiKey, baseUrl);
  }

  // ── Provider Info ───────────────────────────────────────────────────

  override getInfo(): ProviderInfo {
    return {
      id: AI_PROVIDER.OPENAI,
      label: AI_PROVIDER_LABELS[AI_PROVIDER.OPENAI],
      baseUrl: this.baseUrl,
      isLocal: false,
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: true,
      maxContextTokens: 128_000,
      envKeyName: AI_PROVIDER_ENV_KEYS[AI_PROVIDER.OPENAI],
    };
  }

  // ── Model Discovery (with chat-model filtering) ─────────────────────

  /**
   * Fetch models from the OpenAI API and filter to only chat-relevant
   * models that support tool/function calling.
   *
   * OpenAI's /v1/models endpoint returns hundreds of models across
   * all product lines (embeddings, whisper, dall-e, tts, moderation,
   * fine-tunes, etc.). We aggressively filter to only surface models
   * the user would actually want for security analysis.
   */
  override async listModels(): Promise<ModelFetchResult> {
    const result = await fetchModels(
      AI_PROVIDER.OPENAI,
      this.apiKey,
      this.baseUrl,
    );

    if (!result.ok) return result;

    // Filter to only chat-completion-relevant models
    const filteredAll = result.allModels.filter(isChatModel);
    const filteredToolCalling = result.toolCallingModels.filter(isChatModel);

    // Update the cached models on this instance
    this.cachedModels =
      filteredToolCalling.length > 0 ? filteredToolCalling : filteredAll;

    return {
      ...result,
      allModels: filteredAll,
      toolCallingModels: filteredToolCalling,
    };
  }

  // ── Health Check (with smarter error messages) ──────────────────────

  override async healthCheck(): Promise<ProviderHealthCheck> {
    const start = performance.now();

    try {
      const result = await this.listModels();
      const latencyMs = performance.now() - start;

      if (!result.ok) {
        // Provide a more helpful error for common OpenAI issues
        let error = result.error ?? "Unknown error";

        if (error.includes("401") || error.includes("Unauthorized")) {
          error =
            "Invalid API key. Verify your OPENAI_API_KEY is correct and has not been revoked.";
        } else if (error.includes("429") || error.includes("Rate limit")) {
          error =
            "Rate limited by OpenAI. Wait a moment and try again, or check your billing/quota.";
        } else if (error.includes("403") || error.includes("Forbidden")) {
          error =
            "API key does not have permission to list models. Check your OpenAI account permissions.";
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
          "Cannot reach the OpenAI API. Check your network connection and firewall settings.";
      } else if (
        message.includes("timeout") ||
        message.includes("TimeoutError")
      ) {
        friendlyMessage =
          "Connection to OpenAI timed out. The API may be experiencing high load.";
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
 * Determine whether a discovered model is a chat-completion model
 * suitable for security analysis with tool calling.
 *
 * This function implements a two-pass filter:
 * 1. **Inclusion pass**: The model ID must start with one of the known
 *    chat model prefixes (gpt-4*, gpt-3.5*, o1*, o3*, o4*, chatgpt*).
 * 2. **Exclusion pass**: The model ID must NOT match any of the explicit
 *    exclude patterns (base models, instruct-only, audio, realtime, etc.).
 *
 * This approach is resilient to new model releases — any new model
 * starting with a known chat prefix will be automatically included,
 * while clearly non-chat models are excluded by pattern.
 */
function isChatModel(model: DiscoveredModel): boolean {
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
 * Create a new OpenAI provider instance.
 *
 * This is the factory function registered with the provider registry.
 * It follows the ProviderFactory signature: (apiKey, baseUrl) => BaseProvider.
 *
 * @param apiKey  - OpenAI API key (sk-...).
 * @param baseUrl - Base URL for the OpenAI API
 *                  (default: https://api.openai.com).
 * @returns A configured OpenAIProvider instance.
 */
export function createProvider(
  apiKey: string,
  baseUrl: string,
): OpenAIProvider {
  return new OpenAIProvider(apiKey, baseUrl);
}
