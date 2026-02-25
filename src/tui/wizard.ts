// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — First-Run TUI Wizard
// ─────────────────────────────────────────────────────────────────────────────
// Interactive setup wizard that runs on first launch (or when invoked via
// the /conf command). Walks the user through:
//
//   1. Personalization — AI display name + host/user name
//   2. Provider selection — choose from Anthropic, OpenAI, Gemini, etc.
//   3. API key entry — masked password input (or Ollama URL)
//   4. Model discovery — fetch available models, let user pick default
//   5. MCP web search — optionally enable Brave/Serper/Tavily + API key
//   6. Confirmation — validate + save configuration
//
// The wizard stores its results in ~/.crack-code/config.json via the
// config manager. It can be re-run at any time to update settings.
//
// Zero external dependencies.
// ─────────────────────────────────────────────────────────────────────────────

import {
  bold,
  dim,
  cyan,
  green,
  yellow,
  red,
  white,
  brightCyan,
  brightGreen,
  brightMagenta,
  gray,
  italic,
  stripAnsi,
  SHIELD_ICON,
  CHECK_MARK,
  CROSS_MARK,
  WARNING_MARK,
  ARROW_RIGHT,
  ROCKET_ICON,
  KEY_ICON,
  GEAR_ICON,
  SEARCH_ICON,
  LOCK_ICON,
} from "../utils/colors.js";

import {
  APP_NAME,
  APP_VERSION,
  APP_DESCRIPTION,
  AI_PROVIDER,
  AI_PROVIDER_LABELS,
  AI_PROVIDER_BASE_URLS,
  AI_PROVIDER_ENV_KEYS,
  type AIProvider,
  MCP_PROVIDER,
  MCP_PROVIDER_LABELS,
  MCP_PROVIDERS_REQUIRING_KEY,
  MCP_PROVIDER_ENV_KEYS,
  WEB_SEARCH_CHOICES,
  type MCPProvider,
} from "../utils/constants.js";

import {
  type CrackCodeConfig,
  loadConfig,
  saveConfig,
  createDefaultConfig,
  setProvider,
  setMCP,
  setDisplay,
  markWizardCompleted,
  getEffectiveApiKey,
  getEffectiveBaseUrl,
  getProviderLabel,
  getMaskedApiKey,
  getMaskedMCPApiKey,
  validateConfig,
  getConfigSummary,
  ensureConfigDir,
} from "../config/index.js";

import {
  askQuestion,
  askPassword,
  selectOption,
  confirm,
  withSpinner,
  printSuccess,
  printError,
  printWarning,
  printInfo,
  printBlank,
  printDivider,
  waitForKey,
  type SelectChoice,
} from "./prompt.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** Result of running the wizard */
export interface WizardResult {
  /** Whether the wizard completed successfully */
  completed: boolean;
  /** The final configuration (saved to disk) */
  config: CrackCodeConfig;
  /** Whether the user cancelled */
  cancelled: boolean;
  /** Error message if the wizard failed */
  error?: string;
}

/** Options for running the wizard */
export interface WizardOptions {
  /** If true, only run sections that have missing/invalid config */
  onlyMissing?: boolean;
  /** If true, skip the welcome banner */
  skipBanner?: boolean;
  /** If true, skip the MCP section */
  skipMCP?: boolean;
  /** If true, skip the personalization section */
  skipPersonalization?: boolean;
  /** Section to jump to directly */
  section?: "personalization" | "provider" | "model" | "mcp" | "all";
}

// ── Banner ──────────────────────────────────────────────────────────────────

const WIZARD_BANNER_LINES = [
  "",
  `  ${brightCyan("╔══════════════════════════════════════════════════════════════╗")}`,
  `  ${brightCyan("║")}                                                              ${brightCyan("║")}`,
  `  ${brightCyan("║")}   ${SHIELD_ICON}  ${bold(brightCyan(APP_NAME))} ${dim("v" + APP_VERSION)}                                  ${brightCyan("║")}`,
  `  ${brightCyan("║")}   ${dim(APP_DESCRIPTION)}          ${brightCyan("║")}`,
  `  ${brightCyan("║")}                                                              ${brightCyan("║")}`,
  `  ${brightCyan("║")}   ${bold(white("First-Run Setup Wizard"))}                                  ${brightCyan("║")}`,
  `  ${brightCyan("║")}   ${dim("Let's configure your security analysis environment.")}       ${brightCyan("║")}`,
  `  ${brightCyan("║")}                                                              ${brightCyan("║")}`,
  `  ${brightCyan("╚══════════════════════════════════════════════════════════════╝")}`,
  "",
];

function renderWizardBanner(): void {
  for (const line of WIZARD_BANNER_LINES) {
    process.stdout.write(line + "\n");
  }
}

// ── Step Header ─────────────────────────────────────────────────────────────

function renderStepHeader(
  stepNumber: number,
  totalSteps: number,
  title: string,
  description: string
): void {
  printBlank();
  printDivider(
    `${dim(`Step ${stepNumber}/${totalSteps}`)} ${bold(cyan(title))}`,
    60
  );
  printInfo(dim(description));
  printBlank();
}

// ── Section Divider ─────────────────────────────────────────────────────────

function renderSectionComplete(message: string): void {
  printBlank();
  printSuccess(message);
  printBlank();
}

// ═════════════════════════════════════════════════════════════════════════════
// Main Wizard Flow
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Run the complete first-run wizard.
 *
 * This is the primary entry point. It guides the user through all
 * configuration steps and persists the result.
 *
 * @param options - Wizard configuration options.
 * @returns The wizard result with the final config.
 */
export async function runWizard(
  options: WizardOptions = {}
): Promise<WizardResult> {
  try {
    await ensureConfigDir();

    // Load existing config (or defaults)
    let config = await loadConfig();

    // Show banner
    if (!options.skipBanner) {
      renderWizardBanner();
    }

    const totalSteps = computeTotalSteps(options);
    let currentStep = 0;

    // ── Step 1: Personalization ──────────────────────────────────────
    if (
      !options.skipPersonalization &&
      (options.section === "personalization" ||
        options.section === "all" ||
        !options.section)
    ) {
      currentStep++;
      config = await stepPersonalization(config, currentStep, totalSteps);
    }

    // ── Step 2: Provider Selection ──────────────────────────────────
    if (
      options.section === "provider" ||
      options.section === "all" ||
      !options.section
    ) {
      currentStep++;
      const providerResult = await stepProviderSelection(
        config,
        currentStep,
        totalSteps
      );
      if (providerResult.cancelled) {
        return {
          completed: false,
          config,
          cancelled: true,
        };
      }
      config = providerResult.config;
    }

    // ── Step 3: API Key ─────────────────────────────────────────────
    if (
      options.section === "provider" ||
      options.section === "all" ||
      !options.section
    ) {
      currentStep++;
      const apiKeyResult = await stepApiKey(config, currentStep, totalSteps);
      if (apiKeyResult.cancelled) {
        return {
          completed: false,
          config,
          cancelled: true,
        };
      }
      config = apiKeyResult.config;
    }

    // ── Step 4: Model Selection ─────────────────────────────────────
    if (
      options.section === "model" ||
      options.section === "provider" ||
      options.section === "all" ||
      !options.section
    ) {
      currentStep++;
      config = await stepModelSelection(config, currentStep, totalSteps);
    }

    // ── Step 5: MCP / Web Search ────────────────────────────────────
    if (
      !options.skipMCP &&
      (options.section === "mcp" ||
        options.section === "all" ||
        !options.section)
    ) {
      currentStep++;
      config = await stepMCPSetup(config, currentStep, totalSteps);
    }

    // ── Final: Validate & Save ──────────────────────────────────────
    config = markWizardCompleted(config);
    await saveConfig(config);

    renderWizardComplete(config);

    return {
      completed: true,
      config,
      cancelled: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`Wizard error: ${message}`);
    return {
      completed: false,
      config: createDefaultConfig(),
      cancelled: false,
      error: message,
    };
  }
}

/**
 * Compute the total number of steps based on options.
 */
function computeTotalSteps(options: WizardOptions): number {
  let steps = 0;

  if (
    !options.skipPersonalization &&
    (options.section === "personalization" ||
      options.section === "all" ||
      !options.section)
  ) {
    steps++;
  }

  if (
    options.section === "provider" ||
    options.section === "all" ||
    !options.section
  ) {
    steps += 2; // provider + API key
  }

  if (
    options.section === "model" ||
    options.section === "provider" ||
    options.section === "all" ||
    !options.section
  ) {
    steps++;
  }

  if (
    !options.skipMCP &&
    (options.section === "mcp" ||
      options.section === "all" ||
      !options.section)
  ) {
    steps++;
  }

  return Math.max(steps, 1);
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 1: Personalization
// ═════════════════════════════════════════════════════════════════════════════

async function stepPersonalization(
  config: CrackCodeConfig,
  step: number,
  total: number
): Promise<CrackCodeConfig> {
  renderStepHeader(
    step,
    total,
    "Personalization",
    "Set your display name and how the AI introduces itself."
  );

  // AI Name
  const aiName = await askQuestion("What should the AI call itself?", {
    defaultValue: config.display.aiName || APP_NAME,
    hint: `(default: ${APP_NAME})`,
    validate: (input: string) => {
      if (input.length > 50) return "Name must be 50 characters or fewer.";
      return null;
    },
  });

  // Host Name
  const hostName = await askQuestion("What's your name or handle?", {
    defaultValue: config.display.hostName || inferDefaultHostName(),
    hint: "(shown on the dashboard)",
    validate: (input: string) => {
      if (input.length > 50) return "Name must be 50 characters or fewer.";
      return null;
    },
  });

  config = setDisplay(config, {
    aiName: aiName || APP_NAME,
    hostName: hostName || "user",
  });

  renderSectionComplete(
    `Personalization set: AI is ${bold(cyan(config.display.aiName))}, ` +
      `host is ${bold(cyan(config.display.hostName))}`
  );

  return config;
}

/**
 * Infer a default host name from environment variables.
 */
function inferDefaultHostName(): string {
  const env = typeof process !== "undefined" ? process.env : ({} as Record<string, string | undefined>);
  return (
    env["USER"] ??
    env["USERNAME"] ??
    env["LOGNAME"] ??
    env["HOSTNAME"] ??
    "user"
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 2: Provider Selection
// ═════════════════════════════════════════════════════════════════════════════

async function stepProviderSelection(
  config: CrackCodeConfig,
  step: number,
  total: number
): Promise<{ config: CrackCodeConfig; cancelled: boolean }> {
  renderStepHeader(
    step,
    total,
    "AI Provider",
    "Choose which AI provider to use for security analysis."
  );

  const providers = Object.values(AI_PROVIDER) as AIProvider[];

  const choices: SelectChoice<AIProvider | null>[] = providers.map((id) => {
    const label = AI_PROVIDER_LABELS[id] ?? id;
    const envKey = AI_PROVIDER_ENV_KEYS[id] ?? "";
    const hasEnvKey = envKey ? !!process.env[envKey] : false;
    const isLocal = id === AI_PROVIDER.OLLAMA;

    let description: string;
    if (isLocal) {
      description = "Local — no API key required, runs on your machine";
    } else if (hasEnvKey) {
      description = `API key detected in ${envKey}`;
    } else {
      description = `Requires API key (env: ${envKey})`;
    }

    return {
      value: id,
      label,
      description,
    };
  });

  const selected = await selectOption<AIProvider | null>(
    "Select your AI provider:",
    choices
  );

  if (selected === null) {
    return { config, cancelled: true };
  }

  // Update provider (API key and model will be set in subsequent steps)
  config = setProvider(
    config,
    selected,
    config.provider.apiKey,
    config.provider.defaultModel,
    ""
  );

  renderSectionComplete(
    `Provider selected: ${bold(cyan(AI_PROVIDER_LABELS[selected] ?? selected))}`
  );

  return { config, cancelled: false };
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 3: API Key / Ollama URL
// ═════════════════════════════════════════════════════════════════════════════

async function stepApiKey(
  config: CrackCodeConfig,
  step: number,
  total: number
): Promise<{ config: CrackCodeConfig; cancelled: boolean }> {
  const providerId = config.provider.id;
  const providerLabel = AI_PROVIDER_LABELS[providerId] ?? providerId;
  const isOllama = providerId === AI_PROVIDER.OLLAMA;
  const envKey = AI_PROVIDER_ENV_KEYS[providerId] ?? "";
  const envValue = envKey ? process.env[envKey] ?? "" : "";

  if (isOllama) {
    // ── Ollama: ask for server URL ──────────────────────────────────
    renderStepHeader(
      step,
      total,
      "Ollama Configuration",
      "Configure the URL of your local Ollama server."
    );

    const defaultUrl =
      config.provider.baseUrl ||
      AI_PROVIDER_BASE_URLS[AI_PROVIDER.OLLAMA] ||
      "http://localhost:11434";

    const ollamaUrl = await askQuestion("Ollama server URL:", {
      defaultValue: defaultUrl,
      hint: `(default: ${defaultUrl})`,
      validate: (input: string) => {
        try {
          new URL(input);
          return null;
        } catch {
          return "Please enter a valid URL (e.g. http://localhost:11434).";
        }
      },
    });

    config = setProvider(
      config,
      providerId,
      "",
      config.provider.defaultModel,
      ollamaUrl || defaultUrl
    );

    // Test Ollama connectivity
    const reachable = await testOllamaConnection(
      config.provider.baseUrl || defaultUrl
    );

    if (reachable) {
      renderSectionComplete(
        `Ollama server is reachable at ${bold(cyan(ollamaUrl || defaultUrl))}`
      );
    } else {
      printWarning(
        `Could not reach Ollama at ${ollamaUrl || defaultUrl}. ` +
          "Make sure Ollama is running and the URL is correct."
      );
      printInfo(dim("You can continue anyway and fix this later via /conf."));
      printBlank();
    }

    return { config, cancelled: false };
  }

  // ── Cloud Provider: ask for API key ──────────────────────────────

  renderStepHeader(
    step,
    total,
    `${providerLabel} API Key`,
    `Enter your API key for ${providerLabel}. The key is stored locally and never sent anywhere except to ${providerLabel}'s API.`
  );

  // Check if key is already in the environment
  if (envValue) {
    printInfo(
      `${green(CHECK_MARK)} API key detected in environment variable ${bold(envKey)}.`
    );

    const useEnv = await confirm("Use the key from the environment?", {
      defaultValue: true,
    });

    if (useEnv) {
      config = setProvider(
        config,
        providerId,
        "", // Don't store in config — read from env at runtime
        config.provider.defaultModel,
        config.provider.baseUrl
      );

      renderSectionComplete(
        `Using ${providerLabel} API key from ${bold(envKey)}`
      );
      return { config, cancelled: false };
    }
  }

  // Prompt for API key
  const apiKey = await askPassword(`Enter your ${providerLabel} API key:`, {
    validate: (input: string) => {
      if (!input || input.length < 8) {
        return "API key appears too short. Please check and try again.";
      }
      return null;
    },
    hint: dim("(input is masked)"),
  });

  if (!apiKey) {
    printWarning("No API key provided. You can set it later via /conf.");
    return { config, cancelled: false };
  }

  config = setProvider(
    config,
    providerId,
    apiKey,
    config.provider.defaultModel,
    config.provider.baseUrl
  );

  // Validate the key
  const keyValid = await validateApiKeyConnection(config);

  if (keyValid) {
    const masked = getMaskedApiKey(config);
    renderSectionComplete(
      `${providerLabel} API key verified: ${dim(masked)}`
    );
  } else {
    printWarning(
      `Could not verify the API key with ${providerLabel}. ` +
        "The key may be invalid, or there may be a network issue."
    );
    printInfo(dim("You can continue anyway and fix this later via /conf."));
    printBlank();
  }

  return { config, cancelled: false };
}

/**
 * Test Ollama server connectivity.
 */
async function testOllamaConnection(baseUrl: string): Promise<boolean> {
  try {
    const result = await withSpinner("Testing Ollama connection...", async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      try {
        const response = await fetch(`${baseUrl}/api/tags`, {
          method: "GET",
          signal: controller.signal,
        });
        clearTimeout(timeout);
        return response.ok;
      } catch {
        clearTimeout(timeout);
        return false;
      }
    });
    return result;
  } catch {
    return false;
  }
}

/**
 * Validate API key by attempting a connection to the provider.
 */
async function validateApiKeyConnection(
  config: CrackCodeConfig
): Promise<boolean> {
  try {
    const result = await withSpinner(
      `Verifying ${getProviderLabel(config)} API key...`,
      async () => {
        const { validateProviderConnection } = await import(
          "../providers/model-fetcher.js"
        );

        const apiKey = getEffectiveApiKey(config);
        const baseUrl = getEffectiveBaseUrl(config);

        const validation = await validateProviderConnection(
          config.provider.id,
          apiKey,
          baseUrl
        );

        return validation.valid;
      }
    );
    return result;
  } catch {
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 4: Model Selection
// ═════════════════════════════════════════════════════════════════════════════

async function stepModelSelection(
  config: CrackCodeConfig,
  step: number,
  total: number
): Promise<CrackCodeConfig> {
  const providerLabel = getProviderLabel(config);

  renderStepHeader(
    step,
    total,
    "Model Selection",
    `Fetching available models from ${providerLabel}... ` +
      "We'll filter for models that support tool/function calling."
  );

  // Fetch models from the provider
  let modelChoices: SelectChoice<string>[] = [];
  let fetchError: string | null = null;

  try {
    const models = await withSpinner(
      `Discovering models from ${providerLabel}...`,
      async () => {
        const { fetchModels } = await import("../providers/model-fetcher.js");

        const apiKey = getEffectiveApiKey(config);
        const baseUrl = getEffectiveBaseUrl(config);

        const result = await fetchModels(config.provider.id, apiKey, baseUrl);
        return result;
      }
    );

    if (models.ok) {
      // Prefer tool-calling models, but show all if none detected
      const displayModels =
        models.toolCallingModels.length > 0
          ? models.toolCallingModels
          : models.allModels;

      if (displayModels.length === 0) {
        fetchError =
          "No models were returned by the provider. " +
          "You can enter a model ID manually.";
      } else {
        const { formatModelChoices } = await import(
          "../providers/model-fetcher.js"
        );

        modelChoices = formatModelChoices(displayModels).map((choice) => ({
          value: choice.value,
          label: choice.label,
        }));

        printInfo(
          `Found ${bold(String(displayModels.length))} model${displayModels.length !== 1 ? "s" : ""} ` +
            (models.toolCallingModels.length > 0
              ? `(${models.toolCallingModels.length} with tool calling)`
              : "(tool-calling detection not available for this provider)")
        );
        printBlank();
      }
    } else {
      fetchError = models.error ?? "Failed to fetch models.";
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fetchError = `Model discovery failed: ${message}`;
  }

  if (fetchError) {
    printWarning(fetchError);
    printBlank();
  }

  // Let user select from discovered models or enter manually
  let selectedModel = "";

  if (modelChoices.length > 0) {
    // Add a manual entry option at the end
    modelChoices.push({
      value: "__manual__",
      label: dim("Enter a model ID manually..."),
    });

    const selected = await selectOption<string>(
      "Select your default model:",
      modelChoices,
      { maxVisible: 12 }
    );

    if (selected && selected !== "__manual__") {
      selectedModel = selected;
    }
  }

  // Manual entry fallback
  if (!selectedModel) {
    selectedModel = await askQuestion("Enter the model ID:", {
      defaultValue: config.provider.defaultModel || "",
      hint: dim("(e.g. claude-sonnet-4-20250514, gpt-4o, gemini-2.5-pro)"),
      validate: (input: string) => {
        if (!input || input.length < 2) {
          return "Please enter a valid model ID.";
        }
        return null;
      },
    });
  }

  if (selectedModel) {
    config = setProvider(
      config,
      config.provider.id,
      config.provider.apiKey,
      selectedModel,
      config.provider.baseUrl
    );

    renderSectionComplete(
      `Default model: ${bold(cyan(selectedModel))}`
    );
  } else {
    printWarning("No model selected. You can set one later via /conf.");
    printBlank();
  }

  return config;
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 5: MCP / Web Search Configuration
// ═════════════════════════════════════════════════════════════════════════════

async function stepMCPSetup(
  config: CrackCodeConfig,
  step: number,
  total: number
): Promise<CrackCodeConfig> {
  renderStepHeader(
    step,
    total,
    "Web Search (MCP)",
    "Optionally enable web search for CVE lookups, advisory checks, and " +
      "best-practice documentation. Uses the Model Context Protocol (MCP)."
  );

  printInfo(
    dim(
      "Context7 MCP is always available (no API key needed) for documentation lookups."
    )
  );
  printBlank();

  const enableSearch = await confirm(
    "Enable an additional web search provider?",
    { defaultValue: false }
  );

  if (!enableSearch) {
    config = setMCP(config, false, null, "");
    renderSectionComplete("Web search: using Context7 only (no extra search provider).");
    return config;
  }

  // Select web search provider
  const searchChoices: SelectChoice<string>[] = WEB_SEARCH_CHOICES.map(
    (choice) => ({
      value: choice.value,
      label: choice.label,
      description:
        choice.value === "skip"
          ? undefined
          : (MCP_PROVIDERS_REQUIRING_KEY as readonly string[]).includes(
                choice.value
              )
            ? `Requires API key (env: ${MCP_PROVIDER_ENV_KEYS[choice.value] ?? "N/A"})`
            : "No API key required",
    })
  );

  const selectedSearch = await selectOption<string>(
    "Select a web search provider:",
    searchChoices
  );

  if (!selectedSearch || selectedSearch === "skip") {
    config = setMCP(config, false, null, "");
    renderSectionComplete("Web search: using Context7 only.");
    return config;
  }

  const mcpProvider = selectedSearch as MCPProvider;
  const requiresKey = (MCP_PROVIDERS_REQUIRING_KEY as readonly string[]).includes(
    mcpProvider
  );

  let mcpApiKey = "";

  if (requiresKey) {
    const envKeyName = MCP_PROVIDER_ENV_KEYS[mcpProvider];
    const envValue = envKeyName ? process.env[envKeyName] ?? "" : "";

    if (envValue) {
      printInfo(
        `${green(CHECK_MARK)} API key detected in ${bold(envKeyName ?? "environment")}.`
      );

      const useEnv = await confirm("Use the key from the environment?", {
        defaultValue: true,
      });

      if (!useEnv) {
        mcpApiKey = await askPassword(
          `Enter your ${MCP_PROVIDER_LABELS[mcpProvider] ?? mcpProvider} API key:`,
          {
            hint: dim("(input is masked)"),
          }
        );
      }
      // If using env, leave mcpApiKey empty — read at runtime
    } else {
      mcpApiKey = await askPassword(
        `Enter your ${MCP_PROVIDER_LABELS[mcpProvider] ?? mcpProvider} API key:`,
        {
          hint: dim("(input is masked)"),
          allowEmpty: true,
        }
      );

      if (!mcpApiKey) {
        printWarning(
          `No API key provided for ${MCP_PROVIDER_LABELS[mcpProvider] ?? mcpProvider}. ` +
            "Web search will not work without it."
        );
      }
    }
  }

  config = setMCP(config, true, mcpProvider, mcpApiKey);

  const mcpLabel = MCP_PROVIDER_LABELS[mcpProvider] ?? mcpProvider;
  renderSectionComplete(
    `Web search enabled: ${bold(cyan(mcpLabel))} + Context7`
  );

  return config;
}

// ═════════════════════════════════════════════════════════════════════════════
// Wizard Complete Screen
// ═════════════════════════════════════════════════════════════════════════════

function renderWizardComplete(config: CrackCodeConfig): void {
  const summary = getConfigSummary(config);
  const validation = validateConfig(config);

  printBlank();
  process.stdout.write(
    brightCyan(
      "  ╔══════════════════════════════════════════════════════════════╗\n"
    )
  );
  process.stdout.write(
    brightCyan("  ║") +
      "                                                              " +
      brightCyan("║\n")
  );
  process.stdout.write(
    brightCyan("  ║") +
      `   ${green(CHECK_MARK)} ${bold(green("Setup Complete!"))}                                        ` +
      brightCyan("║\n")
  );
  process.stdout.write(
    brightCyan("  ║") +
      "                                                              " +
      brightCyan("║\n")
  );
  process.stdout.write(
    brightCyan(
      "  ╚══════════════════════════════════════════════════════════════╝\n"
    )
  );
  printBlank();

  // Summary table
  printDivider("Configuration Summary", 55);
  printBlank();

  const kvWidth = 20;

  const kvLine = (key: string, value: string): void => {
    const paddedKey = key.padEnd(kvWidth);
    process.stdout.write(`  ${dim(paddedKey)} ${white(value)}\n`);
  };

  kvLine("AI Name:", summary.aiName);
  kvLine("Host Name:", summary.hostName);
  kvLine("Provider:", summary.providerLabel);
  kvLine("Model:", summary.model);
  kvLine("API Key:", summary.apiKeySet ? green("configured") : yellow("not set"));
  kvLine(
    "Web Search:",
    summary.mcpEnabled
      ? `${green("enabled")} (${summary.mcpProvider ?? "context7"})`
      : dim("Context7 only")
  );
  kvLine("HUD:", summary.hudEnabled ? green("enabled") : dim("disabled"));

  printBlank();

  // Validation warnings
  if (validation.warnings.length > 0) {
    for (const warning of validation.warnings) {
      printWarning(warning);
    }
    printBlank();
  }

  if (validation.errors.length > 0) {
    for (const error of validation.errors) {
      printError(error);
    }
    printBlank();
  }

  // Usage tips
  printDivider("Getting Started", 55);
  printBlank();
  process.stdout.write(
    `  ${dim("Type a message to start analyzing your code's security.")}\n`
  );
  process.stdout.write(
    `  ${dim("Use")} ${cyan("@path/to/file")} ${dim("to target specific files.")}\n`
  );
  process.stdout.write(
    `  ${dim("Use")} ${cyan("/help")} ${dim("to see all available commands.")}\n`
  );
  process.stdout.write(
    `  ${dim("Use")} ${cyan("/conf")} ${dim("to change settings at any time.")}\n`
  );
  printBlank();
}

// ═════════════════════════════════════════════════════════════════════════════
// Quick Config Editor (for /conf command)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Run the configuration editor (invoked by /conf command).
 *
 * Shows a menu of config sections the user can edit, and runs the
 * appropriate wizard step.
 */
export async function runConfigEditor(): Promise<WizardResult> {
  const config = await loadConfig();

  printBlank();
  printDivider(`${GEAR_ICON} Configuration Editor`, 55);
  printBlank();

  // Show current config summary
  const summary = getConfigSummary(config);

  const kvWidth = 20;
  const kvLine = (key: string, value: string): void => {
    const paddedKey = key.padEnd(kvWidth);
    process.stdout.write(`  ${dim(paddedKey)} ${white(value)}\n`);
  };

  kvLine("AI Name:", summary.aiName);
  kvLine("Host Name:", summary.hostName);
  kvLine("Provider:", summary.providerLabel);
  kvLine("Model:", summary.model);
  kvLine("API Key:", summary.apiKeySet ? green("configured") : yellow("not set"));
  kvLine("Base URL:", summary.baseUrl || dim("(default)"));
  kvLine(
    "MCP:",
    summary.mcpEnabled
      ? `${green("enabled")} (${summary.mcpProvider ?? "context7"})`
      : dim("Context7 only")
  );
  printBlank();

  // Section selection
  const choices: SelectChoice<string>[] = [
    {
      value: "personalization",
      label: "Personalization",
      description: "Change AI name and your display name",
    },
    {
      value: "provider",
      label: "AI Provider",
      description: "Change provider, API key, and model",
    },
    {
      value: "model",
      label: "Model Only",
      description: "Change the default model without switching providers",
    },
    {
      value: "mcp",
      label: "Web Search / MCP",
      description: "Configure web search providers",
    },
    {
      value: "hud",
      label: "Toggle HUD",
      description: `Dashboard is currently ${config.display.hudEnabled ? green("enabled") : dim("disabled")}`,
    },
    {
      value: "reset",
      label: yellow("Reset All"),
      description: "Reset configuration to defaults",
    },
    {
      value: "cancel",
      label: dim("Cancel"),
      description: "Return without changes",
    },
  ];

  const selected = await selectOption<string>(
    "What would you like to change?",
    choices
  );

  if (!selected || selected === "cancel") {
    return {
      completed: false,
      config,
      cancelled: true,
    };
  }

  // HUD toggle (simple toggle, no wizard step)
  if (selected === "hud") {
    const updatedConfig = setDisplay(config, {
      hudEnabled: !config.display.hudEnabled,
    });
    await saveConfig(updatedConfig);
    printSuccess(
      `Dashboard HUD ${updatedConfig.display.hudEnabled ? green("enabled") : dim("disabled")}.`
    );
    return {
      completed: true,
      config: updatedConfig,
      cancelled: false,
    };
  }

  // Reset
  if (selected === "reset") {
    const confirmReset = await confirm(
      "Are you sure you want to reset ALL configuration?",
      { defaultValue: false }
    );

    if (confirmReset) {
      const { resetConfig } = await import("../config/index.js");
      const freshConfig = await resetConfig();
      printSuccess("Configuration reset to defaults.");
      printInfo("Run the wizard again with /conf to set up.");
      return {
        completed: true,
        config: freshConfig,
        cancelled: false,
      };
    }

    return {
      completed: false,
      config,
      cancelled: true,
    };
  }

  // Run the specific wizard section
  return runWizard({
    section: selected as "personalization" | "provider" | "model" | "mcp",
    skipBanner: true,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Re-configuration Helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Check if the wizard needs to run (first-time setup).
 *
 * Returns true if the config doesn't exist or the wizard hasn't been
 * completed yet.
 */
export async function needsWizard(): Promise<boolean> {
  try {
    const { configExists } = await import("../config/index.js");
    const exists = await configExists();
    if (!exists) return true;

    const config = await loadConfig();
    return !config.wizardCompleted;
  } catch {
    return true;
  }
}

/**
 * Ensure the wizard has been run. If not, run it now.
 *
 * @returns The loaded or newly-created configuration.
 */
export async function ensureWizardCompleted(): Promise<CrackCodeConfig> {
  const shouldRun = await needsWizard();

  if (shouldRun) {
    const result = await runWizard();
    if (result.completed) {
      return result.config;
    }
    // Even if cancelled, return whatever config we have
    return result.config;
  }

  return loadConfig();
}

/**
 * Quick API key update (for when the key is invalid/expired).
 *
 * Prompts for a new API key without running the full wizard.
 */
export async function promptForApiKey(
  config: CrackCodeConfig
): Promise<CrackCodeConfig> {
  const providerLabel = getProviderLabel(config);

  printBlank();
  printWarning(
    `${providerLabel} API key is missing or invalid.`
  );
  printBlank();

  if (config.provider.id === AI_PROVIDER.OLLAMA) {
    const url = await askQuestion("Ollama server URL:", {
      defaultValue: getEffectiveBaseUrl(config),
    });

    const updated = setProvider(
      config,
      config.provider.id,
      "",
      config.provider.defaultModel,
      url
    );
    await saveConfig(updated);
    return updated;
  }

  const apiKey = await askPassword(
    `Enter your ${providerLabel} API key:`,
    { hint: dim("(input is masked)") }
  );

  if (!apiKey) {
    printWarning("No API key provided.");
    return config;
  }

  const updated = setProvider(
    config,
    config.provider.id,
    apiKey,
    config.provider.defaultModel,
    config.provider.baseUrl
  );
  await saveConfig(updated);

  printSuccess(`${providerLabel} API key updated.`);

  return updated;
}

/**
 * Quick model selection (for when the model is not set).
 *
 * Fetches models and lets the user pick without running the full wizard.
 */
export async function promptForModel(
  config: CrackCodeConfig
): Promise<CrackCodeConfig> {
  const updated = await stepModelSelection(config, 1, 1);
  await saveConfig(updated);
  return updated;
}
