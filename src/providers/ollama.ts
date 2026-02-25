// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Ollama Local Provider
// ─────────────────────────────────────────────────────────────────────────────
// Concrete implementation of BaseProvider for Ollama's local inference
// server. Ollama provides an OpenAI-compatible chat completions endpoint
// at /v1/chat/completions, but its model listing uses a unique endpoint
// at /api/tags instead of /v1/models. This provider extends the
// OpenAI-compatible base and overrides model discovery and health checks
// to work with Ollama's native API.
//
// Key differences from cloud-hosted OpenAI-compatible providers:
//   1. No authentication required — Ollama runs locally without API keys
//   2. Model listing: GET /api/tags returns { models: [{ name, model,
//      modified_at, size, digest, details }] }
//   3. Chat completions: /v1/chat/completions (standard OpenAI-compatible)
//      OR the native /api/chat endpoint — we use the OpenAI-compatible
//      endpoint for consistency with the shared base class
//   4. Tool-calling support depends on the individual model — Ollama
//      exposes model capabilities via the details.families array and
//      model metadata, but not all models support tools. We detect
//      this by checking the model's template and capabilities metadata.
//   5. Base URL defaults to http://localhost:11434
//   6. The user provides the server URL instead of an API key
//
// Models are fetched dynamically from the local Ollama server at runtime.
// Only models actually pulled/installed on the user's machine are shown.
// Nothing is hardcoded.
//
// Zero external dependencies — uses the built-in fetch API exclusively.
// ─────────────────────────────────────────────────────────────────────────────

import { OpenAICompatibleProvider } from "./openai-compatible.js";

import {
  BaseProvider,
  type ProviderInfo,
  type ProviderHealthCheck,
} from "./base.js";

import {
  type ModelFetchResult,
  type DiscoveredModel,
} from "./model-fetcher.js";

import {
  AI_PROVIDER,
  AI_PROVIDER_LABELS,
  AI_PROVIDER_ENV_KEYS,
  MODEL_FETCH_TIMEOUT_MS,
} from "../utils/constants.js";

// ── Ollama API Types ────────────────────────────────────────────────────────

/** A single model entry returned by GET /api/tags */
interface OllamaModelEntry {
  /** The full model name including tag (e.g. "llama3.1:latest") */
  name: string;
  /** The model identifier used in API calls (e.g. "llama3.1:latest") */
  model: string;
  /** ISO timestamp of when the model was last modified/pulled */
  modified_at: string;
  /** Total size of the model in bytes */
  size: number;
  /** SHA256 digest of the model */
  digest: string;
  /** Model details/metadata */
  details: OllamaModelDetails;
}

/** Detailed metadata about an Ollama model */
interface OllamaModelDetails {
  /** Parent model (e.g. base model it was derived from) */
  parent_model?: string;
  /** Format of the model (e.g. "gguf") */
  format?: string;
  /** Model family (e.g. "llama") */
  family?: string;
  /** Array of model families/capabilities (e.g. ["llama", "tools"]) */
  families?: string[] | null;
  /** Parameter size string (e.g. "8.0B", "70B") */
  parameter_size?: string;
  /** Quantization level (e.g. "Q4_0", "Q5_K_M") */
  quantization_level?: string;
}

/** Response from GET /api/tags */
interface OllamaTagsResponse {
  models: OllamaModelEntry[];
}

/** Response from GET /api/show (model info endpoint) */
interface OllamaShowResponse {
  modelfile?: string;
  parameters?: string;
  template?: string;
  details?: OllamaModelDetails;
  model_info?: Record<string, unknown>;
}

/** Response from GET / (Ollama server root — returns version info) */
interface OllamaVersionResponse {
  version?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/**
 * Model families known to support tool/function calling in Ollama.
 *
 * Ollama models that include "tools" in their details.families array
 * have native tool-calling support built into their chat template.
 * Additionally, certain model families are known to support tool calling
 * through their architecture even if not explicitly tagged.
 *
 * This list is used as a heuristic — if a model's families array contains
 * any of these values, it's considered tool-calling capable.
 */
const TOOL_CAPABLE_FAMILIES = new Set(["tools"]);

/**
 * Model name patterns known to support tool calling even if not
 * explicitly tagged with the "tools" family. These are well-known
 * model architectures that have function-calling capabilities.
 */
const TOOL_CAPABLE_MODEL_PATTERNS: RegExp[] = [
  /^llama3\.[1-9]/i, // Llama 3.1+ supports native tool calling
  /^llama3:\d/i, // Llama 3 with version tags
  /^qwen[23]/i, // Qwen 2/2.5/3 family supports tool calling
  /^mistral/i, // Mistral models support tool calling
  /^mixtral/i, // Mixtral models support tool calling
  /^command-r/i, // Cohere Command R supports tool calling
  /^gemma2/i, // Gemma 2 supports tool calling
  /^phi[34]/i, // Phi-3/4 supports tool calling
  /^deepseek/i, // DeepSeek models support tool calling
  /^hermes/i, // Hermes fine-tunes support tool calling
  /^firefunction/i, // FireFunction models are built for tool calling
  /^nexusraven/i, // NexusRaven is built for function calling
  /^granite/i, // IBM Granite supports tool calling
  /^falcon[23]/i, // Falcon 2/3 supports tool calling
  /^yi-/i, // Yi models support tool calling
  /^glm/i, // GLM models support tool calling
  /^internlm/i, // InternLM models support tool calling
];

// ── Ollama Provider Implementation ──────────────────────────────────────────

class OllamaProvider extends OpenAICompatibleProvider {
  protected readonly providerId = AI_PROVIDER.OLLAMA;

  constructor(apiKey: string, baseUrl: string) {
    // Ollama doesn't use an API key — the apiKey parameter is ignored.
    // The baseUrl is the Ollama server URL (default: http://localhost:11434).
    const effectiveUrl = baseUrl || DEFAULT_OLLAMA_URL;
    super("", effectiveUrl);
  }

  // ── Provider Info ───────────────────────────────────────────────────

  override getInfo(): ProviderInfo {
    return {
      id: AI_PROVIDER.OLLAMA,
      label: AI_PROVIDER_LABELS[AI_PROVIDER.OLLAMA],
      baseUrl: this.baseUrl,
      isLocal: true,
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: true,
      maxContextTokens: 128_000, // Depends on the model, but many support 128K
      envKeyName: AI_PROVIDER_ENV_KEYS[AI_PROVIDER.OLLAMA],
    };
  }

  // ── Headers Override ────────────────────────────────────────────────

  /**
   * Build HTTP headers for Ollama requests.
   *
   * Ollama runs locally and does not require authentication. We only
   * set Content-Type and Accept headers — no Authorization header.
   */
  protected override buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  // ── Model Discovery (via /api/tags) ─────────────────────────────────

  /**
   * Fetch locally installed models from the Ollama server.
   *
   * Unlike cloud providers that use /v1/models, Ollama uses its own
   * /api/tags endpoint which returns a different response structure:
   *
   * ```json
   * {
   *   "models": [
   *     {
   *       "name": "llama3.1:latest",
   *       "model": "llama3.1:latest",
   *       "modified_at": "2024-08-01T...",
   *       "size": 4661224676,
   *       "digest": "62716...",
   *       "details": {
   *         "parent_model": "",
   *         "format": "gguf",
   *         "family": "llama",
   *         "families": ["llama", "tools"],
   *         "parameter_size": "8.0B",
   *         "quantization_level": "Q4_0"
   *       }
   *     }
   *   ]
   * }
   * ```
   *
   * We parse this response manually (instead of using the model-fetcher
   * module) because Ollama's format is unique enough to warrant custom
   * handling. Tool-calling support is detected by checking:
   *
   * 1. Whether the model's details.families array contains "tools"
   * 2. Whether the model name matches a known tool-capable architecture
   *
   * Models that don't meet either criterion are still included in
   * allModels but excluded from toolCallingModels, giving the user
   * visibility into all their installed models while highlighting
   * which ones are best suited for Crack Code's tool-calling workflow.
   */
  override async listModels(): Promise<ModelFetchResult> {
    const start = performance.now();

    try {
      const url = `${this.baseUrl}/api/tags`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS),
      });

      const durationMs = performance.now() - start;

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        let errorMessage = `HTTP ${response.status} ${response.statusText}`;

        if (errorBody) {
          errorMessage += `: ${errorBody.slice(0, 300)}`;
        }

        return {
          ok: false,
          allModels: [],
          toolCallingModels: [],
          error: `Failed to list models from Ollama: ${errorMessage}`,
          durationMs,
          provider: AI_PROVIDER.OLLAMA,
          providerLabel: AI_PROVIDER_LABELS[AI_PROVIDER.OLLAMA],
        };
      }

      const data = (await response.json()) as OllamaTagsResponse;

      if (!data.models || !Array.isArray(data.models)) {
        return {
          ok: true,
          allModels: [],
          toolCallingModels: [],
          error:
            "Ollama is running but no models are installed. " +
            "Pull a model first with: ollama pull <model-name>",
          durationMs,
          provider: AI_PROVIDER.OLLAMA,
          providerLabel: AI_PROVIDER_LABELS[AI_PROVIDER.OLLAMA],
        };
      }

      if (data.models.length === 0) {
        return {
          ok: true,
          allModels: [],
          toolCallingModels: [],
          error:
            "Ollama is running but no models are installed. " +
            "Pull a model first with: ollama pull llama3.1",
          durationMs,
          provider: AI_PROVIDER.OLLAMA,
          providerLabel: AI_PROVIDER_LABELS[AI_PROVIDER.OLLAMA],
        };
      }

      // Transform Ollama model entries into our DiscoveredModel format
      const allModels: DiscoveredModel[] = [];
      const toolCallingModels: DiscoveredModel[] = [];

      for (const entry of data.models) {
        const id = entry.model || entry.name;
        if (!id) continue;

        const supportsToolCalling = detectOllamaToolSupport(entry);
        const displayName = buildOllamaDisplayName(entry);

        const model: DiscoveredModel = {
          id,
          displayName,
          supportsToolCalling,
          provider: AI_PROVIDER.OLLAMA,
          raw: entry as unknown as Record<string, unknown>,
        };

        allModels.push(model);
        if (supportsToolCalling) {
          toolCallingModels.push(model);
        }
      }

      // Sort: tool-capable models first, then alphabetically by ID
      const sortModels = (a: DiscoveredModel, b: DiscoveredModel): number => {
        // Tool-capable models come first
        if (a.supportsToolCalling !== b.supportsToolCalling) {
          return a.supportsToolCalling ? -1 : 1;
        }
        // Then sort alphabetically
        return a.id.localeCompare(b.id);
      };

      allModels.sort(sortModels);
      toolCallingModels.sort((a, b) => a.id.localeCompare(b.id));

      // Update cached models on this instance
      this.cachedModels =
        toolCallingModels.length > 0 ? toolCallingModels : allModels;

      return {
        ok: true,
        allModels,
        toolCallingModels,
        durationMs,
        provider: AI_PROVIDER.OLLAMA,
        providerLabel: AI_PROVIDER_LABELS[AI_PROVIDER.OLLAMA],
      };
    } catch (err) {
      const durationMs = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      let errorDetail: string;

      if (
        err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError")
      ) {
        errorDetail =
          `Ollama server did not respond within ${MODEL_FETCH_TIMEOUT_MS / 1000}s. ` +
          "Ensure Ollama is running: ollama serve";
      } else if (message.includes("ECONNREFUSED")) {
        errorDetail =
          `Cannot connect to Ollama at ${this.baseUrl}. ` +
          "Ensure the Ollama server is running:\n" +
          "  1. Start Ollama: ollama serve\n" +
          "  2. Or check if it's running on a different port/host";
      } else if (
        message.includes("ENOTFOUND") ||
        message.includes("getaddrinfo")
      ) {
        errorDetail =
          `Cannot resolve Ollama host: ${this.baseUrl}. ` +
          "Check the server URL is correct (default: http://localhost:11434).";
      } else {
        errorDetail = `Failed to connect to Ollama: ${message}`;
      }

      return {
        ok: false,
        allModels: [],
        toolCallingModels: [],
        error: errorDetail,
        durationMs,
        provider: AI_PROVIDER.OLLAMA,
        providerLabel: AI_PROVIDER_LABELS[AI_PROVIDER.OLLAMA],
      };
    }
  }

  // ── Health Check ────────────────────────────────────────────────────

  /**
   * Perform a health check against the local Ollama server.
   *
   * We check two things:
   * 1. Is the server reachable? (GET / returns version info)
   * 2. Are any models installed? (GET /api/tags returns model list)
   *
   * This provides comprehensive diagnostics: the user knows whether
   * the issue is that Ollama isn't running vs. no models are pulled.
   */
  override async healthCheck(): Promise<ProviderHealthCheck> {
    const start = performance.now();

    // ── Step 1: Check if Ollama server is reachable ────────────────────
    try {
      const versionResponse = await fetch(`${this.baseUrl}/`, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });

      if (!versionResponse.ok) {
        const latencyMs = performance.now() - start;
        return {
          healthy: false,
          latencyMs,
          error:
            `Ollama server at ${this.baseUrl} returned HTTP ${versionResponse.status}. ` +
            "The server may be misconfigured or running an incompatible version.",
          modelCount: 0,
        };
      }

      // Try to extract version info
      let version = "unknown";
      try {
        const versionText = await versionResponse.text();
        // Ollama's root endpoint returns "Ollama is running" as plain text
        // or a JSON object with version info depending on the version
        if (versionText.includes("Ollama is running")) {
          version = "running";
        } else {
          try {
            const versionData = JSON.parse(
              versionText,
            ) as OllamaVersionResponse;
            version = versionData.version ?? "unknown";
          } catch {
            version = "running";
          }
        }
      } catch {
        // Version extraction is best-effort
      }

      // ── Step 2: Check for installed models ──────────────────────────
      const modelResult = await this.listModels();
      const latencyMs = performance.now() - start;

      if (!modelResult.ok) {
        return {
          healthy: false,
          latencyMs,
          error: modelResult.error,
          modelCount: 0,
          metadata: { version },
        };
      }

      if (modelResult.allModels.length === 0) {
        return {
          healthy: true,
          latencyMs,
          error:
            "Ollama is running but no models are installed. " +
            "Pull a model to get started:\n" +
            "  ollama pull llama3.1\n" +
            "  ollama pull qwen2.5\n" +
            "  ollama pull mistral",
          modelCount: 0,
          metadata: {
            version,
            serverReachable: true,
            noModelsInstalled: true,
          },
        };
      }

      return {
        healthy: true,
        latencyMs,
        modelCount: modelResult.allModels.length,
        metadata: {
          version,
          serverReachable: true,
          totalModels: modelResult.allModels.length,
          toolCallingModels: modelResult.toolCallingModels.length,
          serverUrl: this.baseUrl,
        },
      };
    } catch (err) {
      const latencyMs = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      let friendlyMessage: string;

      if (message.includes("ECONNREFUSED")) {
        friendlyMessage =
          `Ollama server is not running at ${this.baseUrl}.\n\n` +
          "To start Ollama:\n" +
          "  1. Install Ollama from https://ollama.ai/download\n" +
          "  2. Run: ollama serve\n" +
          "  3. Pull a model: ollama pull llama3.1\n\n" +
          "If Ollama is running on a different host or port, update the server URL " +
          "in your Crack Code configuration (/conf).";
      } else if (
        message.includes("timeout") ||
        message.includes("TimeoutError") ||
        message.includes("AbortError")
      ) {
        friendlyMessage =
          `Ollama server at ${this.baseUrl} did not respond within 5 seconds.\n\n` +
          "Possible causes:\n" +
          "  • Ollama is not running (start with: ollama serve)\n" +
          "  • The server is busy loading a model\n" +
          "  • Firewall is blocking the connection\n" +
          "  • Wrong server URL (check your configuration)";
      } else if (
        message.includes("ENOTFOUND") ||
        message.includes("getaddrinfo")
      ) {
        friendlyMessage =
          `Cannot resolve hostname in Ollama URL: ${this.baseUrl}\n\n` +
          "Check that the server URL is correct. The default is http://localhost:11434";
      } else if (
        message.includes("ECONNRESET") ||
        message.includes("socket hang up")
      ) {
        friendlyMessage =
          `Connection to Ollama at ${this.baseUrl} was unexpectedly closed.\n\n` +
          "The server may have crashed or been restarted. Try:\n" +
          "  1. Check if Ollama is still running: ollama list\n" +
          "  2. Restart Ollama: ollama serve\n" +
          "  3. Check system resources (RAM, disk space)";
      } else {
        friendlyMessage =
          `Cannot connect to Ollama at ${this.baseUrl}: ${message}\n\n` +
          "Ensure Ollama is installed and running:\n" +
          "  1. Install: https://ollama.ai/download\n" +
          "  2. Start: ollama serve\n" +
          "  3. Pull a model: ollama pull llama3.1";
      }

      return {
        healthy: false,
        latencyMs,
        error: friendlyMessage,
        modelCount: 0,
        metadata: {
          serverReachable: false,
          serverUrl: this.baseUrl,
        },
      };
    }
  }

  // ── Server URL Management ───────────────────────────────────────────

  /**
   * Get the Ollama server URL.
   * For Ollama, the "base URL" IS the server URL — there is no API key.
   */
  getServerUrl(): string {
    return this.baseUrl;
  }

  /**
   * Set the Ollama server URL.
   * Normalizes the URL (strips trailing slashes, ensures http/https scheme).
   */
  setServerUrl(url: string): void {
    let normalized = url.trim().replace(/\/+$/, "");

    // Add http:// scheme if missing
    if (
      !normalized.startsWith("http://") &&
      !normalized.startsWith("https://")
    ) {
      normalized = `http://${normalized}`;
    }

    this.baseUrl = normalized;
    this.initialized = false;
    this.cachedModels = [];
  }

  /**
   * Override setApiKey to be a no-op for Ollama (no auth needed).
   * The "API key" field is repurposed as the server URL in the config wizard.
   */
  override setApiKey(_apiKey: string): void {
    // No-op: Ollama doesn't use API keys
  }

  /**
   * Override getApiKey to return the server URL instead.
   * This allows the config system to treat the server URL uniformly.
   */
  override getApiKey(): string {
    return this.baseUrl;
  }

  /**
   * Override getMaskedApiKey to show the server URL.
   */
  override getMaskedApiKey(): string {
    return this.baseUrl;
  }
}

// ── Tool-Calling Detection ──────────────────────────────────────────────────

/**
 * Determine whether an Ollama model supports tool/function calling.
 *
 * Tool-calling support in Ollama depends on the model architecture and
 * its chat template. We use a multi-layered heuristic:
 *
 * 1. **Explicit family tag**: If the model's `details.families` array
 *    contains `"tools"`, it explicitly advertises tool-calling support.
 *    This is the most reliable signal — Ollama tags models that have
 *    tool-calling built into their chat template.
 *
 * 2. **Known architecture patterns**: If the model name matches a known
 *    tool-capable architecture (llama3.1+, qwen2/3, mistral, deepseek,
 *    command-r, etc.), we infer tool-calling support. These architectures
 *    are known to have function-calling capabilities even if not explicitly
 *    tagged by Ollama.
 *
 * 3. **Fallback**: Models that don't match either heuristic are assumed
 *    to NOT support tool calling. They're still included in allModels
 *    so the user can see what's installed, but excluded from
 *    toolCallingModels to guide them toward capable models.
 *
 * Note: This is inherently a heuristic. Some fine-tuned or custom models
 * may support tool calling without being detected here. If the user
 * selects such a model, the system will still attempt tool calling —
 * the worst case is the model ignoring tool definitions and responding
 * with plain text instead.
 */
function detectOllamaToolSupport(entry: OllamaModelEntry): boolean {
  // ── Check 1: Explicit "tools" family tag ──────────────────────────
  if (entry.details?.families && Array.isArray(entry.details.families)) {
    for (const family of entry.details.families) {
      if (TOOL_CAPABLE_FAMILIES.has(family.toLowerCase())) {
        return true;
      }
    }
  }

  // ── Check 2: Known tool-capable model architectures ───────────────
  const modelName = (entry.model || entry.name || "").toLowerCase();

  for (const pattern of TOOL_CAPABLE_MODEL_PATTERNS) {
    if (pattern.test(modelName)) {
      return true;
    }
  }

  // ── Check 3: Family-level detection ───────────────────────────────
  // Some models don't have "tools" in families but their base family
  // is known to support tool calling
  const family = entry.details?.family?.toLowerCase() ?? "";
  const toolCapableFamilies = [
    "llama", // Llama 3.1+ supports tools (but older llama2 doesn't)
    "qwen2",
    "qwen3",
    "command-r",
    "mistral",
    "gemma2",
    "phi3",
    "deepseek2",
  ];

  if (family && toolCapableFamilies.includes(family)) {
    return true;
  }

  // ── Default: assume no tool calling support ───────────────────────
  return false;
}

// ── Display Name Builder ────────────────────────────────────────────────────

/**
 * Build a human-friendly display name for an Ollama model.
 *
 * Combines the model name with useful metadata (parameter size,
 * quantization level) to help the user make an informed selection.
 *
 * Examples:
 *   "llama3.1:latest"     → "llama3.1:latest (8.0B, Q4_0)"
 *   "qwen2.5:7b-q5_k_m"  → "qwen2.5:7b-q5_k_m (7.0B, Q5_K_M)"
 *   "mistral:latest"      → "mistral:latest (7.2B, Q4_0)"
 */
function buildOllamaDisplayName(entry: OllamaModelEntry): string {
  const name = entry.model || entry.name || "unknown";
  const parts: string[] = [];

  if (entry.details?.parameter_size) {
    parts.push(entry.details.parameter_size);
  }

  if (entry.details?.quantization_level) {
    parts.push(entry.details.quantization_level);
  }

  if (parts.length > 0) {
    return `${name} (${parts.join(", ")})`;
  }

  return name;
}

// ── Size Formatting Utility ─────────────────────────────────────────────────

/**
 * Format a model's size in bytes to a human-readable string.
 * Used in diagnostics and display output.
 *
 * @param bytes - Size in bytes
 * @returns Formatted string (e.g. "4.3 GB", "891 MB")
 */
export function formatModelSize(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);

  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i] ?? "??"}`;
}

// ── Standalone Utility Functions ────────────────────────────────────────────

/**
 * Check if an Ollama server is reachable at the given URL.
 *
 * This is a lightweight connectivity check that does NOT require a
 * provider instance. It can be used during the configuration wizard
 * to validate the server URL before proceeding.
 *
 * @param serverUrl - The Ollama server URL to check (default: http://localhost:11434)
 * @returns true if the server responds to a GET / request
 */
export async function isOllamaReachable(
  serverUrl: string = DEFAULT_OLLAMA_URL,
): Promise<boolean> {
  try {
    const normalized = serverUrl.replace(/\/+$/, "");
    const response = await fetch(`${normalized}/`, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get basic info about a running Ollama server without creating a
 * full provider instance.
 *
 * @param serverUrl - The Ollama server URL (default: http://localhost:11434)
 * @returns Server info including version and installed model count
 */
export async function getOllamaServerInfo(
  serverUrl: string = DEFAULT_OLLAMA_URL,
): Promise<{
  reachable: boolean;
  version: string | null;
  modelCount: number;
  models: string[];
  error?: string;
}> {
  const normalized = serverUrl.replace(/\/+$/, "");

  try {
    // Check server root for version
    const rootResponse = await fetch(`${normalized}/`, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });

    if (!rootResponse.ok) {
      return {
        reachable: false,
        version: null,
        modelCount: 0,
        models: [],
        error: `Server returned HTTP ${rootResponse.status}`,
      };
    }

    let version: string | null = null;
    try {
      const text = await rootResponse.text();
      if (text.includes("Ollama is running")) {
        version = "running";
      } else {
        const data = JSON.parse(text) as OllamaVersionResponse;
        version = data.version ?? null;
      }
    } catch {
      version = "unknown";
    }

    // Fetch model list
    const tagsResponse = await fetch(`${normalized}/api/tags`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });

    if (!tagsResponse.ok) {
      return {
        reachable: true,
        version,
        modelCount: 0,
        models: [],
        error: "Server is running but failed to list models",
      };
    }

    const tagsData = (await tagsResponse.json()) as OllamaTagsResponse;
    const models = (tagsData.models ?? []).map((m) => m.model || m.name);

    return {
      reachable: true,
      version,
      modelCount: models.length,
      models,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      reachable: false,
      version: null,
      modelCount: 0,
      models: [],
      error: message,
    };
  }
}

// ── Factory Function ────────────────────────────────────────────────────────

/**
 * Create a new Ollama provider instance.
 *
 * This is the factory function registered with the provider registry.
 * It follows the ProviderFactory signature: (apiKey, baseUrl) => BaseProvider.
 *
 * For Ollama, the parameters are interpreted differently than cloud providers:
 * - apiKey:  Ignored (Ollama doesn't use authentication). The configuration
 *            wizard stores the server URL in this field for consistency.
 * - baseUrl: The Ollama server URL (default: http://localhost:11434).
 *            This is where the local Ollama instance is running.
 *
 * @param apiKey  - Ignored for Ollama (no authentication).
 * @param baseUrl - Ollama server URL (default: http://localhost:11434).
 * @returns A configured OllamaProvider instance.
 */
export function createProvider(apiKey: string, baseUrl: string): BaseProvider {
  // For Ollama, if the apiKey looks like a URL (user provided server URL
  // in the API key field during setup), use it as the base URL instead.
  let effectiveBaseUrl = baseUrl || DEFAULT_OLLAMA_URL;

  if (
    apiKey &&
    (apiKey.startsWith("http://") || apiKey.startsWith("https://"))
  ) {
    effectiveBaseUrl = apiKey;
  }

  return new OllamaProvider("", effectiveBaseUrl);
}
