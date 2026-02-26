// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Dynamic Model Fetcher
// ─────────────────────────────────────────────────────────────────────────────
// Queries each AI provider's model-listing API at runtime to discover
// available models and filter for tool-calling capability. No hardcoded
// model names — everything is resolved live from the provider.
// ─────────────────────────────────────────────────────────────────────────────

import {
  type AIProvider,
  type ModelDiscoveryConfig,
  AI_PROVIDER,
  AI_PROVIDER_BASE_URLS,
  AI_PROVIDER_LABELS,
  MODEL_DISCOVERY,
  MODEL_FETCH_TIMEOUT_MS,
} from "../utils/constants.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** A single model discovered from a provider's API */
export interface DiscoveredModel {
  /** The model identifier used in API requests (e.g. "claude-sonnet-4-20250514") */
  id: string;
  /** Human-friendly display name (falls back to id if not available) */
  displayName: string;
  /** Whether this model supports tool/function calling */
  supportsToolCalling: boolean;
  /** The provider this model belongs to */
  provider: AIProvider;
  /** Raw metadata from the API response (for debugging / future use) */
  raw: Record<string, unknown>;
}

/** Result of a model fetch attempt */
export interface ModelFetchResult {
  /** Whether the fetch succeeded */
  ok: boolean;
  /** All discovered models (unfiltered) */
  allModels: DiscoveredModel[];
  /** Only models that support tool calling */
  toolCallingModels: DiscoveredModel[];
  /** Error message if the fetch failed */
  error?: string;
  /** How long the fetch took in milliseconds */
  durationMs: number;
  /** The provider that was queried */
  provider: AIProvider;
  /** Human-readable provider label */
  providerLabel: string;
}

/** Cache entry for fetched models */
interface CacheEntry {
  result: ModelFetchResult;
  timestamp: number;
}

// ── Cache ───────────────────────────────────────────────────────────────────

/** In-memory cache so we don't hammer APIs during a single session */
const modelCache = new Map<string, CacheEntry>();

/** Cache TTL: 10 minutes */
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Build a cache key from provider + baseUrl + apiKey (hashed loosely).
 * We include a truncated key fingerprint so switching keys invalidates cache.
 */
function cacheKey(
  provider: AIProvider,
  baseUrl: string,
  apiKey: string,
): string {
  const keyFingerprint =
    apiKey.length > 8
      ? apiKey.slice(0, 4) + "..." + apiKey.slice(-4)
      : apiKey.length > 0
        ? "***"
        : "none";
  return `${provider}::${baseUrl}::${keyFingerprint}`;
}

/**
 * Clear the model cache for a specific provider, or all providers.
 */
export function clearModelCache(provider?: AIProvider): void {
  if (provider) {
    for (const key of modelCache.keys()) {
      if (key.startsWith(`${provider}::`)) {
        modelCache.delete(key);
      }
    }
  } else {
    modelCache.clear();
  }
}

// ── Deep Value Access ───────────────────────────────────────────────────────

/**
 * Resolve a dot-notation path against an object.
 * E.g. getNestedValue(obj, "endpoints.chat.is_tool_use_supported")
 */
function getNestedValue(obj: unknown, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

// ── Tool-Calling Detection ──────────────────────────────────────────────────

/**
 * Determine whether a single model object supports tool calling,
 * based on the provider's discovery configuration.
 */
function detectToolCalling(
  modelObj: Record<string, unknown>,
  config: ModelDiscoveryConfig,
): boolean {
  switch (config.toolCallDetection) {
    // ── Every model returned is assumed to support tool calling ──────
    case "all":
      return true;

    // ── Gemini-style: check supportedGenerationMethods array ────────
    case "generation_methods": {
      const methods = modelObj["supportedGenerationMethods"];
      if (Array.isArray(methods)) {
        return methods.includes("generateContent");
      }
      return false;
    }

    // ── Check a specific boolean or array field ─────────────────────
    case "field": {
      if (!config.toolCallField) return true;

      const fieldValue = getNestedValue(modelObj, config.toolCallField);

      // Boolean field
      if (typeof fieldValue === "boolean") return fieldValue;

      // Array field — check if it contains a specific value
      if (Array.isArray(fieldValue)) {
        if (config.toolCallFieldValue) {
          return fieldValue.includes(config.toolCallFieldValue);
        }
        // If no specific value required, non-empty array = supported
        return fieldValue.length > 0;
      }

      // String field — non-empty = supported
      if (typeof fieldValue === "string") {
        if (config.toolCallFieldValue) {
          return fieldValue === config.toolCallFieldValue;
        }
        return fieldValue.length > 0;
      }

      // Truthy check as fallback
      return Boolean(fieldValue);
    }

    // ── Check a nested capabilities object for a boolean flag ───────
    case "capabilities_field": {
      if (!config.capabilitiesPath) return true;

      const capValue = getNestedValue(modelObj, config.capabilitiesPath);

      if (typeof capValue === "boolean") return capValue;
      if (typeof capValue === "string")
        return capValue.toLowerCase() === "true";

      return Boolean(capValue);
    }

    default:
      return true;
  }
}

// ── Request Building ────────────────────────────────────────────────────────

/**
 * Build the full URL for the model listing request.
 */
function buildRequestUrl(
  baseUrl: string,
  config: ModelDiscoveryConfig,
  apiKey: string,
): string {
  // Strip trailing slash from base URL
  const base = baseUrl.replace(/\/+$/, "");
  let path = config.path;

  // Substitute API key into URL if auth style is "query"
  if (config.authStyle === "query") {
    path = path.replace("{{API_KEY}}", encodeURIComponent(apiKey));
  }

  return `${base}${path}`;
}

/**
 * Build the headers for the model listing request.
 */
function buildRequestHeaders(
  config: ModelDiscoveryConfig,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  // Auth header
  switch (config.authStyle) {
    case "bearer":
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      break;
    case "x-api-key":
      if (apiKey) {
        headers["x-api-key"] = apiKey;
      }
      break;
    case "query":
    case "none":
      // No auth header needed
      break;
  }

  // Extra static headers (e.g. anthropic-version)
  if (config.extraHeaders) {
    for (const [key, value] of Object.entries(config.extraHeaders)) {
      headers[key] = value;
    }
  }

  return headers;
}

// ── Response Parsing ────────────────────────────────────────────────────────

/**
 * Extract the array of model objects from the API response JSON.
 */
function extractModelsArray(
  responseBody: unknown,
  config: ModelDiscoveryConfig,
): Record<string, unknown>[] {
  const raw = getNestedValue(responseBody, config.modelsArrayPath);

  if (!Array.isArray(raw)) {
    return [];
  }

  // Filter out entries that aren't objects
  return raw.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null,
  );
}

/**
 * Extract the model ID string from a single model object.
 */
function extractModelId(
  modelObj: Record<string, unknown>,
  config: ModelDiscoveryConfig,
): string {
  const raw = getNestedValue(modelObj, config.modelIdKey);
  if (typeof raw !== "string") return "";

  // Gemini returns "models/gemini-2.0-flash" — strip the prefix
  if (raw.startsWith("models/")) {
    return raw.slice("models/".length);
  }

  return raw;
}

/**
 * Extract a display name from a model object, falling back to the ID.
 */
function extractDisplayName(
  modelObj: Record<string, unknown>,
  config: ModelDiscoveryConfig,
  fallbackId: string,
): string {
  if (config.modelDisplayNameKey) {
    const raw = getNestedValue(modelObj, config.modelDisplayNameKey);
    if (typeof raw === "string" && raw.length > 0) {
      return raw;
    }
  }
  return fallbackId;
}

// ── Core Fetch Logic ────────────────────────────────────────────────────────

/**
 * Fetch models from a single provider's API.
 *
 * @param provider  - The AI provider identifier.
 * @param apiKey    - The API key (or empty string for keyless providers like Ollama).
 * @param baseUrl   - Optional override for the provider's base URL.
 * @param useCache  - Whether to return cached results if available (default true).
 * @returns A structured result with all models and tool-calling-capable models.
 */
export async function fetchModels(
  provider: AIProvider,
  apiKey: string,
  baseUrl?: string,
  useCache: boolean = true,
): Promise<ModelFetchResult> {
  const effectiveBaseUrl = baseUrl ?? AI_PROVIDER_BASE_URLS[provider];
  const providerLabel = AI_PROVIDER_LABELS[provider];
  const config = MODEL_DISCOVERY[provider];

  const start = performance.now();

  // ── Check cache ───────────────────────────────────────────────────
  if (useCache) {
    const key = cacheKey(provider, effectiveBaseUrl, apiKey);
    const cached = modelCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return {
        ...cached.result,
        durationMs: 0, // Indicate cache hit
      };
    }
  }

  // ── Build request ─────────────────────────────────────────────────
  const url = buildRequestUrl(effectiveBaseUrl, config, apiKey);
  const headers = buildRequestHeaders(config, apiKey);

  const fetchInit: RequestInit = {
    method: config.method,
    headers,
    signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS),
  };

  if (config.method === "POST" && config.body) {
    fetchInit.body = JSON.stringify(config.body);
  }

  // ── Execute request ───────────────────────────────────────────────
  let responseBody: unknown;
  try {
    const response = await fetch(url, fetchInit);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const durationMs = performance.now() - start;

      let errorDetail = `HTTP ${response.status} ${response.statusText}`;
      if (errorText) {
        // Try to extract a message from JSON error response
        try {
          const errorJson = JSON.parse(errorText);
          const msg =
            errorJson?.error?.message ??
            errorJson?.message ??
            errorJson?.detail ??
            errorText.slice(0, 200);
          errorDetail += `: ${msg}`;
        } catch {
          errorDetail += `: ${errorText.slice(0, 200)}`;
        }
      }

      return {
        ok: false,
        allModels: [],
        toolCallingModels: [],
        error: `Failed to list models from ${providerLabel}: ${errorDetail}`,
        durationMs,
        provider,
        providerLabel,
      };
    }

    responseBody = await response.json();
  } catch (err) {
    const durationMs = performance.now() - start;
    const message =
      err instanceof Error
        ? err.name === "AbortError" || err.name === "TimeoutError"
          ? `Request timed out after ${MODEL_FETCH_TIMEOUT_MS / 1000}s`
          : err.message
        : String(err);

    return {
      ok: false,
      allModels: [],
      toolCallingModels: [],
      error: `Failed to connect to ${providerLabel}: ${message}`,
      durationMs,
      provider,
      providerLabel,
    };
  }

  // ── Parse response ────────────────────────────────────────────────
  const modelObjects = extractModelsArray(responseBody, config);

  if (modelObjects.length === 0) {
    const durationMs = performance.now() - start;
    return {
      ok: true,
      allModels: [],
      toolCallingModels: [],
      error: `No models returned by ${providerLabel}. The API key may be invalid or the account may have no model access.`,
      durationMs,
      provider,
      providerLabel,
    };
  }

  // ── Build discovered models ───────────────────────────────────────
  const allModels: DiscoveredModel[] = [];
  const toolCallingModels: DiscoveredModel[] = [];

  for (const modelObj of modelObjects) {
    const id = extractModelId(modelObj, config);
    if (!id) continue; // Skip entries with no usable ID

    const displayName = extractDisplayName(modelObj, config, id);
    const supportsToolCalling = detectToolCalling(modelObj, config);

    const model: DiscoveredModel = {
      id,
      displayName,
      supportsToolCalling,
      provider,
      raw: modelObj,
    };

    allModels.push(model);
    if (supportsToolCalling) {
      toolCallingModels.push(model);
    }
  }

  // Sort models: prefer shorter/cleaner names, then alphabetically
  const sortModels = (a: DiscoveredModel, b: DiscoveredModel): number => {
    // Prefer models without "preview", "experimental", "deprecated" in name
    const aHasTag = /preview|experimental|deprecated/i.test(a.id) ? 1 : 0;
    const bHasTag = /preview|experimental|deprecated/i.test(b.id) ? 1 : 0;
    if (aHasTag !== bHasTag) return aHasTag - bHasTag;

    // Sort alphabetically by ID
    return a.id.localeCompare(b.id);
  };

  allModels.sort(sortModels);
  toolCallingModels.sort(sortModels);

  const durationMs = performance.now() - start;

  const result: ModelFetchResult = {
    ok: true,
    allModels,
    toolCallingModels,
    durationMs,
    provider,
    providerLabel,
  };

  // ── Store in cache ────────────────────────────────────────────────
  const key = cacheKey(provider, effectiveBaseUrl, apiKey);
  modelCache.set(key, { result, timestamp: Date.now() });

  return result;
}

// ── Provider-Specific Convenience Functions ─────────────────────────────────

/**
 * Fetch tool-calling models from Anthropic Claude.
 */
export async function fetchAnthropicModels(
  apiKey: string,
): Promise<ModelFetchResult> {
  return fetchModels(AI_PROVIDER.ANTHROPIC, apiKey);
}

/**
 * Fetch tool-calling models from OpenAI.
 * Filters to only chat-relevant models (gpt-*, o1-*, o3-*, o4-*, chatgpt-*).
 */
export async function fetchOpenAIModels(
  apiKey: string,
): Promise<ModelFetchResult> {
  const result = await fetchModels(AI_PROVIDER.OPENAI, apiKey);

  if (!result.ok) return result;

  // OpenAI returns many models including embeddings, whisper, dall-e, tts etc.
  // Filter to only chat/completion models that are relevant for our use case.
  const chatModelPrefixes = ["gpt-4", "gpt-3.5", "o1", "o3", "o4", "chatgpt"];

  // Models to explicitly exclude (fine-tuned snapshots, instruct variants
  // that don't support tool calling well, etc.)
  const excludePatterns = [
    /^gpt-4-base/,
    /-\d{4}$/, // date-only suffixed duplicates when the base exists
  ];

  const filterChat = (m: DiscoveredModel): boolean => {
    const id = m.id.toLowerCase();

    // Must start with one of the known chat prefixes
    const matchesPrefix = chatModelPrefixes.some((prefix) =>
      id.startsWith(prefix),
    );
    if (!matchesPrefix) return false;

    // Must not match any exclude patterns
    for (const pattern of excludePatterns) {
      if (pattern.test(id)) return false;
    }

    return true;
  };

  return {
    ...result,
    allModels: result.allModels.filter(filterChat),
    toolCallingModels: result.toolCallingModels.filter(filterChat),
  };
}

/**
 * Fetch tool-calling models from Google Gemini.
 * Only returns models that include "generateContent" in their
 * supportedGenerationMethods.
 */
export async function fetchGeminiModels(
  apiKey: string,
): Promise<ModelFetchResult> {
  return fetchModels(AI_PROVIDER.GEMINI, apiKey);
}

/**
 * Fetch tool-calling models from Google Vertex AI.
 *
 * Uses Bearer token authentication and the Vertex AI publisher endpoint.
 * The base URL should be the regional endpoint, e.g.
 * `https://us-central1-aiplatform.googleapis.com`.
 */
export async function fetchVertexAIModels(
  accessToken: string,
  baseUrl?: string,
): Promise<ModelFetchResult> {
  return fetchModels(AI_PROVIDER.VERTEX_AI, accessToken, baseUrl);
}

/**
 * Fetch tool-calling models from Cohere.
 */
export async function fetchCohereModels(
  apiKey: string,
): Promise<ModelFetchResult> {
  return fetchModels(AI_PROVIDER.COHERE, apiKey);
}

/**
 * Fetch models from xAI (Grok).
 */
export async function fetchXAIModels(
  apiKey: string,
): Promise<ModelFetchResult> {
  return fetchModels(AI_PROVIDER.XAI, apiKey);
}

/**
 * Fetch models from Alibaba Qwen via DashScope.
 */
export async function fetchQwenModels(
  apiKey: string,
): Promise<ModelFetchResult> {
  return fetchModels(AI_PROVIDER.QWEN, apiKey);
}

/**
 * Fetch models from Moonshot (Kimi).
 */
export async function fetchMoonshotModels(
  apiKey: string,
): Promise<ModelFetchResult> {
  return fetchModels(AI_PROVIDER.MOONSHOT, apiKey);
}

/**
 * Fetch locally installed models from Ollama.
 *
 * @param serverUrl - The Ollama server URL (default: http://localhost:11434)
 */
export async function fetchOllamaModels(
  serverUrl: string = "http://localhost:11434",
): Promise<ModelFetchResult> {
  return fetchModels(AI_PROVIDER.OLLAMA, "", serverUrl);
}

// ── Multi-Provider Fetch ────────────────────────────────────────────────────

/** Configuration for fetching models from a specific provider */
export interface ProviderFetchConfig {
  provider: AIProvider;
  apiKey: string;
  baseUrl?: string;
}

/**
 * Fetch models from multiple providers in parallel.
 * Returns a map of provider → result.
 */
export async function fetchModelsFromMultipleProviders(
  configs: ProviderFetchConfig[],
): Promise<Map<AIProvider, ModelFetchResult>> {
  const results = new Map<AIProvider, ModelFetchResult>();

  const promises = configs.map(async (cfg) => {
    const result = await fetchModels(cfg.provider, cfg.apiKey, cfg.baseUrl);
    results.set(cfg.provider, result);
  });

  await Promise.allSettled(promises);

  return results;
}

// ── Validation Helpers ──────────────────────────────────────────────────────

/**
 * Quickly validate that an API key / endpoint is functional by attempting
 * to list models. Does NOT use cache.
 *
 * @returns true if the API responded with at least one model.
 */
export async function validateProviderConnection(
  provider: AIProvider,
  apiKey: string,
  baseUrl?: string,
): Promise<{ valid: boolean; error?: string; modelCount: number }> {
  const result = await fetchModels(provider, apiKey, baseUrl, false);

  if (!result.ok) {
    return { valid: false, error: result.error, modelCount: 0 };
  }

  if (result.allModels.length === 0) {
    return {
      valid: false,
      error: result.error ?? "No models available",
      modelCount: 0,
    };
  }

  return { valid: true, modelCount: result.allModels.length };
}

/**
 * Check if Ollama is running and reachable at the given server URL.
 */
export async function isOllamaReachable(
  serverUrl: string = "http://localhost:11434",
): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ── Display Helpers ─────────────────────────────────────────────────────────

/**
 * Format a list of discovered models into display-friendly strings
 * for TUI selection menus.
 *
 * Each entry is formatted as:
 *   "model-id  (Display Name)" or just "model-id" if names match.
 */
export function formatModelChoices(
  models: DiscoveredModel[],
): Array<{ value: string; label: string }> {
  return models.map((m) => {
    const label = m.displayName !== m.id ? `${m.id}  (${m.displayName})` : m.id;

    return { value: m.id, label };
  });
}

/**
 * Get a short summary string describing the fetch result.
 * E.g. "Found 12 models (8 with tool calling) in 1.2s"
 */
export function formatFetchSummary(result: ModelFetchResult): string {
  if (!result.ok) {
    return `Failed: ${result.error ?? "Unknown error"}`;
  }

  const total = result.allModels.length;
  const tools = result.toolCallingModels.length;
  const time =
    result.durationMs === 0
      ? "(cached)"
      : `in ${(result.durationMs / 1000).toFixed(1)}s`;

  if (total === tools) {
    return `Found ${total} model${total === 1 ? "" : "s"} ${time}`;
  }

  return `Found ${total} model${total === 1 ? "" : "s"} (${tools} with tool calling) ${time}`;
}
