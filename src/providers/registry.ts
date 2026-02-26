// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Provider Registry
// ─────────────────────────────────────────────────────────────────────────────
// Central registry that maps AI provider identifiers to their concrete
// implementations. Resolves the active provider based on configuration,
// provides factory creation, and handles provider lifecycle management.
//
// This module is the single entry-point the rest of the application uses
// to obtain a ready-to-use BaseProvider instance — callers never need to
// import individual provider modules directly.
// ─────────────────────────────────────────────────────────────────────────────

import {
  type AIProvider,
  AI_PROVIDER,
  AI_PROVIDER_LABELS,
  AI_PROVIDER_BASE_URLS,
  AI_PROVIDER_ENV_KEYS,
} from "../utils/constants.js";

import {
  type BaseProvider,
  type ProviderFactory,
  type ProviderInfo,
  type ProviderHealthCheck,
} from "./base.js";

import type { ModelFetchResult, DiscoveredModel } from "./model-fetcher.js";

// ── Registry Entry ──────────────────────────────────────────────────────────

/** Internal bookkeeping for a registered provider */
interface RegistryEntry {
  /** Factory function that creates new provider instances */
  factory: ProviderFactory;
  /** Lazily-created singleton instance (created on first resolve) */
  instance: BaseProvider | null;
  /** Timestamp of last successful health check (epoch ms) */
  lastHealthCheck: number;
  /** Result of the last health check */
  lastHealthResult: ProviderHealthCheck | null;
}

// ── Registry State ──────────────────────────────────────────────────────────

/** Map from provider ID → registry entry */
const registry = new Map<AIProvider, RegistryEntry>();

/** The currently selected / active provider ID */
let activeProviderId: AIProvider | null = null;

/** Error handler called when provider operations fail silently */
let onRegistryError: ((provider: AIProvider, error: string) => void) | null =
  null;

// ── Registration ────────────────────────────────────────────────────────────

/**
 * Register a provider factory function.
 *
 * This should be called once per provider during application bootstrap.
 * The factory is invoked lazily — instances are only created when a
 * provider is first resolved.
 *
 * @param providerId - The provider identifier (e.g. AI_PROVIDER.ANTHROPIC).
 * @param factory    - A function that accepts (apiKey, baseUrl) and returns
 *                     a fully constructed BaseProvider.
 */
export function registerProvider(
  providerId: AIProvider,
  factory: ProviderFactory,
): void {
  registry.set(providerId, {
    factory,
    instance: null,
    lastHealthCheck: 0,
    lastHealthResult: null,
  });
}

/**
 * Remove a provider from the registry.
 * If the removed provider was active, the active provider is cleared.
 */
export function unregisterProvider(providerId: AIProvider): void {
  registry.delete(providerId);
  if (activeProviderId === providerId) {
    activeProviderId = null;
  }
}

/**
 * Check whether a provider is registered.
 */
export function isProviderRegistered(providerId: AIProvider): boolean {
  return registry.has(providerId);
}

/**
 * Get a list of all registered provider IDs.
 */
export function getRegisteredProviders(): AIProvider[] {
  return Array.from(registry.keys());
}

/**
 * Get labels for all registered providers (for TUI selection menus).
 * Returns an array of { value, label } pairs.
 */
export function getProviderChoices(): Array<{
  value: AIProvider;
  label: string;
}> {
  return Array.from(registry.keys()).map((id) => ({
    value: id,
    label: AI_PROVIDER_LABELS[id],
  }));
}

// ── Active Provider ─────────────────────────────────────────────────────────

/**
 * Set the currently active provider.
 *
 * @param providerId - The provider to activate. Must be registered.
 * @throws Error if the provider is not registered.
 */
export function setActiveProvider(providerId: AIProvider): void {
  if (!registry.has(providerId)) {
    throw new Error(
      `Cannot activate provider "${providerId}": not registered. ` +
        `Registered providers: ${getRegisteredProviders().join(", ")}`,
    );
  }
  activeProviderId = providerId;
}

/**
 * Get the currently active provider ID, or null if none is set.
 */
export function getActiveProviderId(): AIProvider | null {
  return activeProviderId;
}

/**
 * Check whether an active provider is set and has a live instance.
 */
export function hasActiveProvider(): boolean {
  if (!activeProviderId) return false;
  const entry = registry.get(activeProviderId);
  return entry?.instance !== null;
}

// ── Instance Resolution ─────────────────────────────────────────────────────

/**
 * Resolve a provider instance by ID.
 *
 * If no instance exists yet, one is created using the registered factory
 * with the supplied API key and base URL. Subsequent calls with the same
 * provider ID return the cached singleton.
 *
 * @param providerId - The provider to resolve.
 * @param apiKey     - API key for the provider (required on first resolve).
 * @param baseUrl    - Optional base URL override. Defaults to the provider's
 *                     standard base URL from constants.
 * @returns The resolved BaseProvider instance.
 * @throws Error if the provider is not registered.
 */
export function resolveProvider(
  providerId: AIProvider,
  apiKey: string = "",
  baseUrl?: string,
): BaseProvider {
  const entry = registry.get(providerId);
  if (!entry) {
    throw new Error(
      `Provider "${providerId}" is not registered. ` +
        `Available providers: ${getRegisteredProviders().join(", ")}`,
    );
  }

  // Return cached instance if it exists
  if (entry.instance) {
    // Update credentials if new ones were supplied
    if (apiKey && apiKey !== entry.instance.getApiKey()) {
      entry.instance.setApiKey(apiKey);
    }
    if (baseUrl && baseUrl !== entry.instance.getBaseUrl()) {
      entry.instance.setBaseUrl(baseUrl);
    }
    return entry.instance;
  }

  // Create a new instance via the factory
  const effectiveBaseUrl = baseUrl ?? AI_PROVIDER_BASE_URLS[providerId];
  const instance = entry.factory(apiKey, effectiveBaseUrl);
  entry.instance = instance;

  return instance;
}

/**
 * Resolve the currently active provider.
 *
 * @param apiKey  - API key (used on first resolve).
 * @param baseUrl - Optional base URL override.
 * @returns The active BaseProvider instance.
 * @throws Error if no active provider is set or if it's not registered.
 */
export function resolveActiveProvider(
  apiKey?: string,
  baseUrl?: string,
): BaseProvider {
  if (!activeProviderId) {
    throw new Error(
      "No active AI provider is configured. " +
        "Run the configuration wizard (/conf) to set one up.",
    );
  }
  return resolveProvider(activeProviderId, apiKey, baseUrl);
}

/**
 * Get the active provider's instance without creating one.
 * Returns null if no active provider is set or if it hasn't been resolved yet.
 */
export function getActiveProviderInstance(): BaseProvider | null {
  if (!activeProviderId) return null;
  return registry.get(activeProviderId)?.instance ?? null;
}

/**
 * Destroy (discard) a provider's cached instance, forcing re-creation
 * on the next resolve call.
 */
export function destroyProviderInstance(providerId: AIProvider): void {
  const entry = registry.get(providerId);
  if (entry) {
    entry.instance = null;
    entry.lastHealthCheck = 0;
    entry.lastHealthResult = null;
  }
}

/**
 * Destroy all cached provider instances.
 */
export function destroyAllInstances(): void {
  for (const entry of registry.values()) {
    entry.instance = null;
    entry.lastHealthCheck = 0;
    entry.lastHealthResult = null;
  }
}

// ── Re-creation with New Credentials ────────────────────────────────────────

/**
 * Recreate a provider instance with updated credentials.
 *
 * This destroys the existing instance (if any) and creates a fresh one
 * with the new API key and/or base URL. Useful when the user changes
 * their configuration.
 *
 * @param providerId - The provider to recreate.
 * @param apiKey     - New API key.
 * @param baseUrl    - New base URL (optional, falls back to default).
 * @returns The newly created BaseProvider instance.
 */
export function recreateProvider(
  providerId: AIProvider,
  apiKey: string,
  baseUrl?: string,
): BaseProvider {
  destroyProviderInstance(providerId);
  return resolveProvider(providerId, apiKey, baseUrl);
}

// ── Health Checks ───────────────────────────────────────────────────────────

/** Minimum interval between health checks for the same provider (30 seconds) */
const HEALTH_CHECK_COOLDOWN_MS = 30_000;

/**
 * Run a health check on a specific provider.
 *
 * Results are cached for HEALTH_CHECK_COOLDOWN_MS to avoid hammering APIs.
 *
 * @param providerId - The provider to check.
 * @param force      - If true, bypass the cooldown and always check.
 * @returns The health check result.
 */
export async function checkProviderHealth(
  providerId: AIProvider,
  force: boolean = false,
): Promise<ProviderHealthCheck> {
  const entry = registry.get(providerId);
  if (!entry) {
    return {
      healthy: false,
      latencyMs: 0,
      error: `Provider "${providerId}" is not registered`,
      modelCount: 0,
    };
  }

  // Return cached result if within cooldown
  if (
    !force &&
    entry.lastHealthResult &&
    Date.now() - entry.lastHealthCheck < HEALTH_CHECK_COOLDOWN_MS
  ) {
    return entry.lastHealthResult;
  }

  // Ensure we have an instance
  if (!entry.instance) {
    return {
      healthy: false,
      latencyMs: 0,
      error: `Provider "${providerId}" has not been resolved yet (no instance)`,
      modelCount: 0,
    };
  }

  try {
    const result = await entry.instance.healthCheck();
    entry.lastHealthCheck = Date.now();
    entry.lastHealthResult = result;
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: ProviderHealthCheck = {
      healthy: false,
      latencyMs: 0,
      error: message,
      modelCount: 0,
    };
    entry.lastHealthCheck = Date.now();
    entry.lastHealthResult = result;

    if (onRegistryError) {
      onRegistryError(providerId, message);
    }

    return result;
  }
}

/**
 * Run health checks on all registered providers that have instances.
 * Returns a map of provider ID → health check result.
 */
export async function checkAllProvidersHealth(
  force: boolean = false,
): Promise<Map<AIProvider, ProviderHealthCheck>> {
  const results = new Map<AIProvider, ProviderHealthCheck>();
  const checks: Promise<void>[] = [];

  for (const [id, entry] of registry) {
    if (entry.instance) {
      checks.push(
        checkProviderHealth(id, force).then((result) => {
          results.set(id, result);
        }),
      );
    }
  }

  await Promise.allSettled(checks);
  return results;
}

// ── Model Discovery (via resolved instances) ────────────────────────────────

/**
 * Fetch models from a specific provider.
 * The provider must have been resolved (have a live instance).
 *
 * @param providerId - The provider to query.
 * @returns The model fetch result.
 */
export async function fetchProviderModels(
  providerId: AIProvider,
): Promise<ModelFetchResult> {
  const entry = registry.get(providerId);
  if (!entry?.instance) {
    return {
      ok: false,
      allModels: [],
      toolCallingModels: [],
      error: `Provider "${providerId}" is not resolved`,
      durationMs: 0,
      provider: providerId,
      providerLabel: AI_PROVIDER_LABELS[providerId],
    };
  }

  return entry.instance.listModels();
}

/**
 * Fetch models from the currently active provider.
 */
export async function fetchActiveProviderModels(): Promise<ModelFetchResult> {
  if (!activeProviderId) {
    return {
      ok: false,
      allModels: [],
      toolCallingModels: [],
      error: "No active provider configured",
      durationMs: 0,
      provider: AI_PROVIDER.OPENAI, // placeholder
      providerLabel: "None",
    };
  }
  return fetchProviderModels(activeProviderId);
}

/**
 * Get cached models from a resolved provider instance.
 * Returns an empty array if the provider isn't resolved or hasn't fetched models.
 */
export function getCachedModels(providerId: AIProvider): DiscoveredModel[] {
  const entry = registry.get(providerId);
  return entry?.instance?.getCachedModels() ?? [];
}

/**
 * Get cached tool-calling models from a resolved provider instance.
 */
export function getCachedToolCallingModels(
  providerId: AIProvider,
): DiscoveredModel[] {
  const entry = registry.get(providerId);
  return entry?.instance?.getToolCallingModels() ?? [];
}

// ── Provider Info Aggregation ───────────────────────────────────────────────

/**
 * Get static info for all registered providers.
 */
export function getAllProviderInfo(): ProviderInfo[] {
  const infos: ProviderInfo[] = [];
  for (const entry of registry.values()) {
    if (entry.instance) {
      infos.push(entry.instance.getInfo());
    }
  }
  return infos;
}

/**
 * Get a summary of the registry state for diagnostics / TUI display.
 */
export function getRegistrySummary(): {
  totalRegistered: number;
  totalResolved: number;
  activeProvider: AIProvider | null;
  activeProviderLabel: string | null;
  activeModel: string | null;
  providers: Array<{
    id: AIProvider;
    label: string;
    resolved: boolean;
    initialized: boolean;
    model: string | null;
    healthy: boolean | null;
  }>;
} {
  const providers: Array<{
    id: AIProvider;
    label: string;
    resolved: boolean;
    initialized: boolean;
    model: string | null;
    healthy: boolean | null;
  }> = [];

  let totalResolved = 0;

  for (const [id, entry] of registry) {
    const resolved = entry.instance !== null;
    if (resolved) totalResolved++;

    providers.push({
      id,
      label: AI_PROVIDER_LABELS[id],
      resolved,
      initialized: entry.instance?.isInitialized() ?? false,
      model: entry.instance?.getSelectedModel() ?? null,
      healthy: entry.lastHealthResult?.healthy ?? null,
    });
  }

  const activeInstance = activeProviderId
    ? (registry.get(activeProviderId)?.instance ?? null)
    : null;

  return {
    totalRegistered: registry.size,
    totalResolved,
    activeProvider: activeProviderId,
    activeProviderLabel: activeProviderId
      ? AI_PROVIDER_LABELS[activeProviderId]
      : null,
    activeModel: activeInstance?.getSelectedModel() ?? null,
    providers,
  };
}

// ── Error Handling ──────────────────────────────────────────────────────────

/**
 * Register a global error handler for silent provider failures.
 * This is called when health checks or background operations fail.
 */
export function setRegistryErrorHandler(
  handler: (provider: AIProvider, error: string) => void,
): void {
  onRegistryError = handler;
}

// ── Environment Variable Resolution ─────────────────────────────────────────

/**
 * Attempt to resolve an API key from environment variables for a provider.
 * Returns the key value or an empty string if not found.
 */
export function resolveApiKeyFromEnv(providerId: AIProvider): string {
  const envKey = AI_PROVIDER_ENV_KEYS[providerId];
  if (!envKey) return "";
  return process.env[envKey] ?? "";
}

/**
 * Check if a provider's API key is available in the environment.
 */
export function isApiKeyInEnv(providerId: AIProvider): boolean {
  return resolveApiKeyFromEnv(providerId).length > 0;
}

/**
 * Get a map of all providers that have API keys available in the environment.
 */
export function getEnvConfiguredProviders(): Map<AIProvider, string> {
  const configured = new Map<AIProvider, string>();

  for (const id of Object.values(AI_PROVIDER)) {
    const key = resolveApiKeyFromEnv(id);
    if (key) {
      configured.set(id, key);
    }
  }

  return configured;
}

// ── Bootstrap Helpers ───────────────────────────────────────────────────────

/**
 * Register all built-in providers.
 *
 * This function lazily imports each provider module and registers its
 * factory. It should be called once during application startup before
 * any provider resolution.
 *
 * Provider modules are imported dynamically so that the registry module
 * itself has no hard dependency on concrete implementations — keeping
 * the architecture modular and allowing individual providers to be
 * swapped or disabled.
 */
export async function registerAllBuiltinProviders(): Promise<void> {
  // Dynamic imports — each provider module must export a `createProvider`
  // factory function that matches the ProviderFactory signature.

  const providerModules: Array<{
    id: AIProvider;
    importPath: string;
  }> = [
    { id: AI_PROVIDER.ANTHROPIC, importPath: "./anthropic.js" },
    { id: AI_PROVIDER.OPENAI, importPath: "./openai.js" },
    { id: AI_PROVIDER.GEMINI, importPath: "./gemini.js" },
    { id: AI_PROVIDER.VERTEX_AI, importPath: "./vertex-ai.js" },
    { id: AI_PROVIDER.COHERE, importPath: "./cohere.js" },
    { id: AI_PROVIDER.XAI, importPath: "./xai.js" },
    { id: AI_PROVIDER.QWEN, importPath: "./qwen.js" },
    { id: AI_PROVIDER.MOONSHOT, importPath: "./moonshot.js" },
    { id: AI_PROVIDER.OLLAMA, importPath: "./ollama.js" },
  ];

  const imports = providerModules.map(async ({ id, importPath }) => {
    try {
      const mod = await import(importPath);
      if (typeof mod.createProvider === "function") {
        registerProvider(id, mod.createProvider as ProviderFactory);
      } else {
        // Module loaded but doesn't export createProvider — skip silently.
        // This can happen during development when a provider stub is empty.
      }
    } catch {
      // Module not found or failed to load — skip silently.
      // The provider simply won't be available for selection.
    }
  });

  await Promise.allSettled(imports);
}

/**
 * Convenience: register providers, resolve the active one from config,
 * and initialize it. Returns the ready-to-use provider.
 *
 * @param providerId - Which provider to activate.
 * @param apiKey     - API key for the provider.
 * @param modelId    - Default model to select.
 * @param baseUrl    - Optional base URL override.
 */
export async function bootstrapProvider(
  providerId: AIProvider,
  apiKey: string,
  modelId: string,
  baseUrl?: string,
): Promise<{ provider: BaseProvider; error?: string }> {
  // Ensure providers are registered
  if (registry.size === 0) {
    await registerAllBuiltinProviders();
  }

  // Resolve and activate
  const provider = resolveProvider(providerId, apiKey, baseUrl);
  setActiveProvider(providerId);

  // Set the selected model
  if (modelId) {
    provider.setSelectedModel(modelId);
  }

  // Initialize (validate credentials, fetch models)
  const initResult = await provider.initialize();
  if (!initResult.ok) {
    return { provider, error: initResult.error };
  }

  // If model was specified, validate it against discovered models
  if (modelId && !provider.isValidModel(modelId)) {
    const available = provider.getCachedModels();
    const modelList = available
      .slice(0, 5)
      .map((m) => m.id)
      .join(", ");
    return {
      provider,
      error:
        `Model "${modelId}" was not found in ${AI_PROVIDER_LABELS[providerId]}'s available models. ` +
        `Available: ${modelList}${available.length > 5 ? ` (+${available.length - 5} more)` : ""}`,
    };
  }

  return { provider };
}

// ── Reset (for testing) ─────────────────────────────────────────────────────

/**
 * Reset the entire registry to a clean state.
 * Primarily intended for testing.
 */
export function resetRegistry(): void {
  destroyAllInstances();
  registry.clear();
  activeProviderId = null;
  onRegistryError = null;
}
