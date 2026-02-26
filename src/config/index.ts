// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Configuration Manager
// ─────────────────────────────────────────────────────────────────────────────
// Handles persistence, loading, validation, and mutation of the user's
// configuration. The config file lives at ~/.crack-code/config.json and
// stores the wizard results: provider choice, API key, selected model,
// MCP settings, display preferences, and custom metadata.
//
// The config is never written automatically — all writes go through
// explicit save calls so the user stays in control.
// ─────────────────────────────────────────────────────────────────────────────

import {
  CONFIG_DIR,
  CONFIG_FILE,
  AUDIT_LOG_FILE,
  HISTORY_FILE,
  MCP_CONFIG_FILE,
  CUSTOM_TOOLS_DIR,
  APP_VERSION,
  type AIProvider,
  AI_PROVIDER,
  AI_PROVIDER_LABELS,
  AI_PROVIDER_BASE_URLS,
  AI_PROVIDER_ENV_KEYS,
  type MCPProvider,
  MCP_PROVIDER,
  MCP_PROVIDERS_REQUIRING_KEY,
  MCP_PROVIDER_ENV_KEYS,
  DEFAULT_MCP_SERVERS,
} from "../utils/constants.js";

import {
  exists,
  ensureDir,
  readJsonFile,
  writeJsonFile,
  safeWriteFile,
} from "../utils/fs.js";

// ── Configuration Interfaces ────────────────────────────────────────────────

/** Persisted AI provider configuration */
export interface ProviderConfig {
  /** Selected AI provider identifier */
  id: AIProvider;
  /** API key (or empty string for keyless providers like Ollama) */
  apiKey: string;
  /** Custom base URL override (empty = use default) */
  baseUrl: string;
  /** The default model ID to use */
  defaultModel: string;
}

/** Persisted MCP web-search configuration */
export interface MCPConfig {
  /** Whether web search is enabled */
  enabled: boolean;
  /** Selected MCP provider */
  provider: MCPProvider | null;
  /** API key for the MCP provider (if required) */
  apiKey: string;
  /** Additional MCP servers enabled (by provider ID) */
  enabledServers: MCPProvider[];
}

/** Display / personalization preferences */
export interface DisplayConfig {
  /** The name the AI should use for itself (default "Crack Code") */
  aiName: string;
  /** The user's name or handle (for dashboard greeting) */
  hostName: string;
  /** Whether the HUD (dashboard header) is shown above the prompt */
  hudEnabled: boolean;
  /** Whether to show timestamps in logs */
  showTimestamps: boolean;
  /** Color mode: 'auto' | 'always' | 'never' */
  colorMode: "auto" | "always" | "never";
  /**
   * Icon rendering mode:
   *   "nerd"    — Nerd Font PUA glyphs (requires a patched terminal font).
   *   "unicode" — Standard Unicode symbols (most modern terminals).
   *   "ascii"   — Pure ASCII fallbacks (CI, piped output, legacy terminals).
   *
   * Default: "nerd"
   */
  iconMode: "nerd" | "unicode" | "ascii";
}

/** The complete persisted configuration */
export interface CrackCodeConfig {
  /** Schema version — used for future migrations */
  version: string;
  /** Timestamp of initial creation (ISO 8601) */
  createdAt: string;
  /** Timestamp of last modification (ISO 8601) */
  updatedAt: string;
  /** AI provider settings */
  provider: ProviderConfig;
  /** MCP / web search settings */
  mcp: MCPConfig;
  /** Display & personalization */
  display: DisplayConfig;
  /** The path that was last scanned (for convenience) */
  lastScanPath: string;
  /** Whether the first-run wizard has been completed */
  wizardCompleted: boolean;
}

// ── Defaults ────────────────────────────────────────────────────────────────

/** Returns a fresh default configuration object. */
export function createDefaultConfig(): CrackCodeConfig {
  const now = new Date().toISOString();
  return {
    version: APP_VERSION,
    createdAt: now,
    updatedAt: now,
    provider: {
      id: AI_PROVIDER.ANTHROPIC,
      apiKey: "",
      baseUrl: "",
      defaultModel: "",
    },
    mcp: {
      enabled: false,
      provider: null,
      apiKey: "",
      enabledServers: [...DEFAULT_MCP_SERVERS],
    },
    display: {
      aiName: "Crack Code",
      hostName: inferHostName(),
      hudEnabled: true,
      showTimestamps: false,
      colorMode: "auto",
      iconMode: "nerd",
    },
    lastScanPath: "",
    wizardCompleted: false,
  };
}

/** Best-effort inference of a human-readable host/user name. */
function inferHostName(): string {
  const env =
    typeof process !== "undefined"
      ? process.env
      : ({} as Record<string, string | undefined>);
  return (
    env["USER"] ??
    env["USERNAME"] ??
    env["LOGNAME"] ??
    env["HOSTNAME"] ??
    "user"
  );
}

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Ensure the configuration directory structure exists.
 * Creates ~/.crack-code/ and sub-directories as needed.
 */
export async function ensureConfigDir(): Promise<void> {
  await ensureDir(CONFIG_DIR);
  await ensureDir(CUSTOM_TOOLS_DIR);
}

/**
 * Check whether a configuration file already exists on disk.
 */
export async function configExists(): Promise<boolean> {
  return exists(CONFIG_FILE);
}

/**
 * Load the configuration from disk.
 *
 * - If the file does not exist, returns a default config.
 * - If the file is malformed, returns a default config and sets `_loadError`.
 * - Merges any missing keys from the default to handle schema upgrades.
 */
export async function loadConfig(): Promise<CrackCodeConfig> {
  const defaults = createDefaultConfig();

  const fileExists = await exists(CONFIG_FILE);
  if (!fileExists) {
    return defaults;
  }

  try {
    const raw = await readJsonFile<Partial<CrackCodeConfig>>(CONFIG_FILE);
    if (!raw || typeof raw !== "object") {
      return defaults;
    }
    return mergeWithDefaults(raw, defaults);
  } catch {
    // Corrupt file — return defaults so the wizard re-runs
    return defaults;
  }
}

/**
 * Save the configuration to disk. Updates the `updatedAt` timestamp.
 */
export async function saveConfig(config: CrackCodeConfig): Promise<void> {
  await ensureConfigDir();
  config.updatedAt = new Date().toISOString();
  await writeJsonFile(CONFIG_FILE, config);
}

/**
 * Deep-merge a partial config with defaults, ensuring every key is present.
 */
function mergeWithDefaults(
  partial: Partial<CrackCodeConfig>,
  defaults: CrackCodeConfig,
): CrackCodeConfig {
  return {
    version: partial.version ?? defaults.version,
    createdAt: partial.createdAt ?? defaults.createdAt,
    updatedAt: partial.updatedAt ?? defaults.updatedAt,
    provider: {
      ...defaults.provider,
      ...(partial.provider ?? {}),
    },
    mcp: {
      ...defaults.mcp,
      ...(partial.mcp ?? {}),
      enabledServers:
        partial.mcp?.enabledServers ?? defaults.mcp.enabledServers,
    },
    display: {
      ...defaults.display,
      ...(partial.display ?? {}),
    },
    lastScanPath: partial.lastScanPath ?? defaults.lastScanPath,
    wizardCompleted: partial.wizardCompleted ?? defaults.wizardCompleted,
  };
}

// ── Accessors ───────────────────────────────────────────────────────────────

/**
 * Get the effective base URL for the active provider.
 * Falls back to the default URL if no override is configured.
 */
export function getEffectiveBaseUrl(config: CrackCodeConfig): string {
  if (config.provider.baseUrl) {
    return config.provider.baseUrl;
  }
  return AI_PROVIDER_BASE_URLS[config.provider.id] ?? "";
}

/**
 * Get the effective API key for the active provider.
 * Checks config first, then falls back to the environment variable.
 */
export function getEffectiveApiKey(config: CrackCodeConfig): string {
  if (config.provider.apiKey) {
    return config.provider.apiKey;
  }
  const envKey = AI_PROVIDER_ENV_KEYS[config.provider.id];
  if (envKey) {
    return process.env[envKey] ?? "";
  }
  return "";
}

/**
 * Get the effective MCP API key.
 * Checks config first, then falls back to the environment variable.
 */
export function getEffectiveMCPApiKey(config: CrackCodeConfig): string {
  if (config.mcp.apiKey) {
    return config.mcp.apiKey;
  }
  if (config.mcp.provider) {
    const envKey = MCP_PROVIDER_ENV_KEYS[config.mcp.provider];
    if (envKey) {
      return process.env[envKey] ?? "";
    }
  }
  return "";
}

/**
 * Check whether the active provider requires an API key.
 * (Ollama does not — it only needs a reachable server.)
 */
export function providerRequiresApiKey(config: CrackCodeConfig): boolean {
  return config.provider.id !== AI_PROVIDER.OLLAMA;
}

/**
 * Get a masked version of the provider API key for display.
 */
export function getMaskedApiKey(config: CrackCodeConfig): string {
  const key = getEffectiveApiKey(config);
  if (!key) return "(not set)";
  if (key.length <= 12) return "****";
  return `${key.slice(0, 4)}${"*".repeat(Math.min(key.length - 8, 20))}${key.slice(-4)}`;
}

/**
 * Get a masked version of the MCP API key for display.
 */
export function getMaskedMCPApiKey(config: CrackCodeConfig): string {
  const key = getEffectiveMCPApiKey(config);
  if (!key) return "(not set)";
  if (key.length <= 12) return "****";
  return `${key.slice(0, 4)}${"*".repeat(Math.min(key.length - 8, 20))}${key.slice(-4)}`;
}

/**
 * Get the human-readable label for the active provider.
 */
export function getProviderLabel(config: CrackCodeConfig): string {
  return AI_PROVIDER_LABELS[config.provider.id] ?? config.provider.id;
}

/**
 * Check whether the MCP provider (if any) requires an API key.
 */
export function mcpProviderRequiresKey(config: CrackCodeConfig): boolean {
  if (!config.mcp.provider) return false;
  return (MCP_PROVIDERS_REQUIRING_KEY as readonly string[]).includes(
    config.mcp.provider,
  );
}

// ── Mutators ────────────────────────────────────────────────────────────────

/**
 * Update the AI provider settings.
 * Does NOT save to disk — call saveConfig() separately.
 */
export function setProvider(
  config: CrackCodeConfig,
  providerId: AIProvider,
  apiKey: string,
  defaultModel: string,
  baseUrl: string = "",
): CrackCodeConfig {
  return {
    ...config,
    provider: {
      id: providerId,
      apiKey,
      defaultModel,
      baseUrl,
    },
  };
}

/**
 * Update only the API key.
 */
export function setApiKey(
  config: CrackCodeConfig,
  apiKey: string,
): CrackCodeConfig {
  return {
    ...config,
    provider: {
      ...config.provider,
      apiKey,
    },
  };
}

/**
 * Update the default model.
 */
export function setDefaultModel(
  config: CrackCodeConfig,
  modelId: string,
): CrackCodeConfig {
  return {
    ...config,
    provider: {
      ...config.provider,
      defaultModel: modelId,
    },
  };
}

/**
 * Update MCP configuration.
 */
export function setMCP(
  config: CrackCodeConfig,
  enabled: boolean,
  provider: MCPProvider | null,
  apiKey: string = "",
): CrackCodeConfig {
  const enabledServers = [...config.mcp.enabledServers];

  // Ensure Context7 is always present
  if (!enabledServers.includes(MCP_PROVIDER.CONTEXT7)) {
    enabledServers.push(MCP_PROVIDER.CONTEXT7);
  }

  // Add the selected provider if not already present
  if (provider && !enabledServers.includes(provider)) {
    enabledServers.push(provider);
  }

  return {
    ...config,
    mcp: {
      enabled,
      provider,
      apiKey,
      enabledServers,
    },
  };
}

/**
 * Update display preferences.
 */
export function setDisplay(
  config: CrackCodeConfig,
  updates: Partial<DisplayConfig>,
): CrackCodeConfig {
  return {
    ...config,
    display: {
      ...config.display,
      ...updates,
    },
  };
}

/**
 * Mark the wizard as completed.
 */
export function markWizardCompleted(config: CrackCodeConfig): CrackCodeConfig {
  return {
    ...config,
    wizardCompleted: true,
  };
}

/**
 * Set the last scanned path.
 */
export function setLastScanPath(
  config: CrackCodeConfig,
  scanPath: string,
): CrackCodeConfig {
  return {
    ...config,
    lastScanPath: scanPath,
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Result of a configuration validation check */
export interface ConfigValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate the configuration for completeness and correctness.
 * Does NOT check connectivity — use provider health checks for that.
 */
export function validateConfig(config: CrackCodeConfig): ConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Provider validation
  const validProviders = Object.values(AI_PROVIDER) as string[];
  if (!validProviders.includes(config.provider.id)) {
    errors.push(
      `Unknown AI provider: "${config.provider.id}". ` +
        `Valid options: ${validProviders.join(", ")}`,
    );
  }

  // API key validation (skip for Ollama)
  if (config.provider.id !== AI_PROVIDER.OLLAMA) {
    const key = getEffectiveApiKey(config);
    if (!key) {
      errors.push(
        `No API key configured for ${getProviderLabel(config)}. ` +
          `Set it in the config or via the ${AI_PROVIDER_ENV_KEYS[config.provider.id]} environment variable.`,
      );
    } else if (key.length < 10) {
      warnings.push(
        `API key for ${getProviderLabel(config)} appears unusually short (${key.length} chars).`,
      );
    }
  }

  // Ollama URL validation
  if (config.provider.id === AI_PROVIDER.OLLAMA) {
    const url = getEffectiveBaseUrl(config);
    if (!url) {
      errors.push("Ollama base URL is not configured.");
    } else {
      try {
        new URL(url);
      } catch {
        errors.push(`Invalid Ollama base URL: "${url}"`);
      }
    }
  }

  // Model validation
  if (!config.provider.defaultModel) {
    warnings.push(
      "No default model selected. You will be prompted to choose one.",
    );
  }

  // MCP validation
  if (config.mcp.enabled && config.mcp.provider) {
    if (mcpProviderRequiresKey(config)) {
      const mcpKey = getEffectiveMCPApiKey(config);
      if (!mcpKey) {
        warnings.push(
          `MCP provider "${config.mcp.provider}" requires an API key but none is set.`,
        );
      }
    }
  }

  // Base URL format validation
  if (config.provider.baseUrl) {
    try {
      new URL(config.provider.baseUrl);
    } catch {
      errors.push(`Invalid provider base URL: "${config.provider.baseUrl}"`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ── Audit Logging ───────────────────────────────────────────────────────────

/**
 * Append a line to the audit log.
 * The audit log tracks tool executions, custom tool activity, and key
 * configuration changes for transparency and debugging.
 */
export async function appendAuditLog(
  entry: string,
  category: "tool" | "config" | "mcp" | "agent" | "scan" = "tool",
): Promise<void> {
  try {
    await ensureConfigDir();
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${category.toUpperCase()}] ${entry}\n`;

    const { appendFile } = await import("node:fs/promises");
    await appendFile(AUDIT_LOG_FILE, line, "utf-8");
  } catch {
    // Audit logging is best-effort — never throw
  }
}

// ── History ─────────────────────────────────────────────────────────────────

/** A single conversation history entry */
export interface HistoryEntry {
  /** ISO timestamp */
  timestamp: string;
  /** User's input */
  input: string;
  /** Summary of the AI response (first 200 chars) */
  responseSummary: string;
  /** Provider and model used */
  provider: string;
  model: string;
}

/** Persisted conversation history */
export interface ConversationHistory {
  entries: HistoryEntry[];
  maxEntries: number;
}

const DEFAULT_MAX_HISTORY = 500;

/**
 * Load conversation history from disk.
 */
export async function loadHistory(): Promise<ConversationHistory> {
  const defaults: ConversationHistory = {
    entries: [],
    maxEntries: DEFAULT_MAX_HISTORY,
  };

  const fileExists = await exists(HISTORY_FILE);
  if (!fileExists) return defaults;

  try {
    const raw = await readJsonFile<Partial<ConversationHistory>>(HISTORY_FILE);
    if (!raw || typeof raw !== "object") return defaults;
    return {
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      maxEntries: raw.maxEntries ?? DEFAULT_MAX_HISTORY,
    };
  } catch {
    return defaults;
  }
}

/**
 * Save conversation history to disk.
 * Automatically trims to maxEntries.
 */
export async function saveHistory(history: ConversationHistory): Promise<void> {
  await ensureConfigDir();

  // Trim to max
  if (history.entries.length > history.maxEntries) {
    history.entries = history.entries.slice(
      history.entries.length - history.maxEntries,
    );
  }

  await writeJsonFile(HISTORY_FILE, history);
}

/**
 * Append a single entry to the conversation history.
 */
export async function appendHistory(entry: HistoryEntry): Promise<void> {
  const history = await loadHistory();
  history.entries.push(entry);
  await saveHistory(history);
}

// ── Config Summary ──────────────────────────────────────────────────────────

/** Human-readable summary of the current configuration */
export interface ConfigSummary {
  provider: string;
  providerLabel: string;
  model: string;
  apiKeySet: boolean;
  apiKeyMasked: string;
  baseUrl: string;
  mcpEnabled: boolean;
  mcpProvider: string | null;
  mcpKeySet: boolean;
  aiName: string;
  hostName: string;
  hudEnabled: boolean;
  iconMode: "nerd" | "unicode" | "ascii";
  wizardCompleted: boolean;
  version: string;
}

/**
 * Build a human-readable summary of the configuration.
 */
export function getConfigSummary(config: CrackCodeConfig): ConfigSummary {
  return {
    provider: config.provider.id,
    providerLabel: getProviderLabel(config),
    model: config.provider.defaultModel || "(not selected)",
    apiKeySet: !!getEffectiveApiKey(config),
    apiKeyMasked: getMaskedApiKey(config),
    baseUrl: getEffectiveBaseUrl(config),
    mcpEnabled: config.mcp.enabled,
    mcpProvider: config.mcp.provider,
    mcpKeySet: !!getEffectiveMCPApiKey(config),
    aiName: config.display.aiName,
    hostName: config.display.hostName,
    hudEnabled: config.display.hudEnabled,
    iconMode: config.display.iconMode,
    wizardCompleted: config.wizardCompleted,
    version: config.version,
  };
}

// ── Config Reset ────────────────────────────────────────────────────────────

/**
 * Reset the configuration to defaults and save.
 * Preserves createdAt timestamp.
 */
export async function resetConfig(): Promise<CrackCodeConfig> {
  const existing = await loadConfig();
  const fresh = createDefaultConfig();
  fresh.createdAt = existing.createdAt;
  await saveConfig(fresh);
  return fresh;
}

/**
 * Export the configuration as a sanitized object (API keys removed).
 * Useful for debugging and sharing.
 */
export function exportSanitizedConfig(
  config: CrackCodeConfig,
): CrackCodeConfig {
  return {
    ...config,
    provider: {
      ...config.provider,
      apiKey: config.provider.apiKey ? "(redacted)" : "",
    },
    mcp: {
      ...config.mcp,
      apiKey: config.mcp.apiKey ? "(redacted)" : "",
    },
  };
}
