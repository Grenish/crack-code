import { mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import * as p from "@clack/prompts";
import pc from "picocolors";

import type { ModelInfo } from "./providers/types";
import { fetchAnthropicModels } from "./providers/anthropic";
import { fetchAzureModels } from "./providers/azure";
import { fetchGoogleModels } from "./providers/google";
import { fetchOpenAIModels } from "./providers/openai";
import { fetchOllamaModels } from "./providers/ollama";
import { fetchVertexModels } from "./providers/vertex";
import { fetchOpenRouterModels } from "./providers/openrouter";

import * as readline from "node:readline";
import { CrackCodeLogo } from "./logo/crack-code";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
} as const;

export interface Config {
  userName?: string;
  provider:
    | "openai"
    | "google"
    | "anthropic"
    | "ollama"
    | "azure"
    | "vertex"
    | "openrouter";
  model: string;
  apiKey: string;

  // azure
  resourceName?: string;
  // vertex
  project?: string;
  location?: string;
  vertexClientEmail?: string;
  vertexPrivateKey?: string;

  // generation
  maxTokens: number;
  maxSteps: number;
  thinkingBudget?: number; // reasoning budget for models like Anthropic, OpenAI o3, Google Gemini

  /*
   * permission behavior
   * by-default the editing policy would be false
   * which later can be made true by the user.
   */
  permissionPolicy: "ask" | "skip" | "allow-all" | "deny-all";
  allowEdits: boolean;
  systemPrompt: string;

  // scan settings
  scanPatterns: string[];
  ignorePatterns: string[];

  // context
  cwd: string;

  // web search tool
  searchProvider?: WebSearchProvider;
  searchApiKey?: string;
  searchGoogleCx?: string;
}

export type WebSearchProvider = "google" | "brave" | "tavily";

interface StoredConfig {
  userName?: string;
  provider: Config["provider"];
  model: string;
  apiKey: string;
  allowEdits?: boolean;
  // Azure-specific
  resourceName?: string;
  // Vertex-specific
  project?: string;
  location?: string;
  vertexClientEmail?: string;
  vertexPrivateKey?: string;
  // Web search-specific
  searchProvider?: WebSearchProvider;
  searchApiKey?: string;
  searchGoogleCx?: string;
  // reasoning budget
  thinkingBudget?: number;
}

interface ProviderSetupResult {
  apiKey: string;
  location?: string;
  model: string;
  project?: string;
  provider: Config["provider"];
  resourceName?: string;
  vertexClientEmail?: string;
  vertexPrivateKey?: string;
}

export interface ConfigOverrides {
  provider?: string;
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  maxSteps?: number;
  permissionPolicy?: Config["permissionPolicy"];
  allowEdits?: boolean;
  scanPatterns?: string[];
  ignorePatterns?: string[];
}

export class SetupCancelledError extends Error {
  constructor() {
    super("Setup cancelled.");
    this.name = "SetupCancelledError";
  }
}

export function isSetupCancelledError(
  error: unknown,
): error is SetupCancelledError {
  return error instanceof SetupCancelledError;
}

// constants
const CONFIG_DIR = join(homedir(), ".crack-code");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const PROVIDERS = [
  "anthropic",
  "azure",
  "google",
  "openai",
  "openrouter",
  "ollama",
  "vertex",
] as const;

const API_KEY_ENV: Record<Config["provider"], string> = {
  anthropic: "ANTHROPIC_API_KEY",
  azure: "AZURE_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  ollama: "OLLAMA_ENDPOINT",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  vertex: "", // Vertex uses service account JSON — no single env key
};

const SEARCH_PROVIDERS = ["google", "brave", "tavily"] as const;
const SEARCH_API_KEY_ENV: Record<WebSearchProvider, string> = {
  google: "GOOGLE_SEARCH_API_KEY",
  brave: "BRAVE_SEARCH_API_KEY",
  tavily: "TAVILY_API_KEY",
};
const GOOGLE_SEARCH_CX_ENV = "GOOGLE_SEARCH_ENGINE_ID";

const DEFAULT_SCAN_PATTERNS = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.py",
  "**/*.go",
  "**/*.rs",
  "**/*.java",
  "**/*.rb",
  "**/*.php",
  "**/*.sol",
  "**/*.yaml",
  "**/*.yml",
  "**/*.toml",
  "**/*.json",
  "**/*.env*",
  "**/Dockerfile*",
  "**/*.tf",
];

const DEFAULT_IGNORE_PATTERNS = [
  "node_modules/**",
  ".git/**",
  "dist/**",
  "build/**",
  "coverage/**",
  ".next/**",
  "__pycache__/**",
  "*.lock",
  "*.min.js",
  "*.min.css",
  "vendor/**",
  "target/**",
];

function abortSetup(): never {
  p.cancel("Setup cancelled.");
  throw new SetupCancelledError();
}

function unwrapPrompt<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    abortSetup();
  }

  return value as T;
}

async function promptText(
  message: string,
  options: {
    placeholder?: string;
    initialValue?: string;
    validate?: (value: string) => string | Error | undefined;
  } = {},
): Promise<string> {
  const { validate, ...rest } = options;
  const value = unwrapPrompt(
    await p.text({
      message,
      ...rest,
      validate: validate ? (value) => validate(value ?? "") : undefined,
    }),
  );

  return value.trim();
}

async function promptSecret(
  message: string,
  validate?: (value: string) => string | Error | undefined,
): Promise<string> {
  const value = unwrapPrompt(
    await p.text({
      message,
      validate: validate ? (value) => validate(value ?? "") : undefined,
    }),
  );

  return value.trim();
}

async function promptConfirm(message: string): Promise<boolean> {
  return unwrapPrompt(
    await p.confirm({
      message,
    }),
  );
}

// Stored config (read/write)
async function readStoredConfig(): Promise<StoredConfig | null> {
  const file = Bun.file(CONFIG_PATH);
  if (!(await file.exists())) return null;

  try {
    const data = await file.json();

    // Validate shape — reject configs from older/different versions
    if (
      typeof data !== "object" ||
      data === null ||
      typeof data.provider !== "string" ||
      typeof data.model !== "string" ||
      typeof data.apiKey !== "string"
    ) {
      return null;
    }

    return data as StoredConfig;
  } catch {
    return null;
  }
}

async function writeStoredConfig(stored: StoredConfig): Promise<any> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await Bun.write(CONFIG_PATH, JSON.stringify(stored, null, 2) + "\n");
}

// function for fetching models from the providers api
interface FetchModelsContext {
  resourceName?: string;
  project?: string;
  location?: string;
  vertexClientEmail?: string;
  vertexPrivateKey?: string;
}

export async function fetchModels(
  provider: Config["provider"],
  apiKey: string,
  ctx: FetchModelsContext = {},
): Promise<ModelInfo[]> {
  try {
    switch (provider) {
      case "anthropic":
        return await fetchAnthropicModels(apiKey);
      case "azure": {
        const resource = ctx.resourceName ?? process.env.AZURE_RESOURCE_NAME;
        if (!resource) {
          console.log(
            pc.yellow("\n  Set AZURE_RESOURCE_NAME to list deployed models.\n"),
          );
          return [];
        }
        return await fetchAzureModels(apiKey, resource);
      }
      case "google":
        return await fetchGoogleModels(apiKey);
      case "openai":
        return await fetchOpenAIModels(apiKey);
      case "openrouter":
        return await fetchOpenRouterModels(apiKey);
      case "ollama":
        return await fetchOllamaModels(apiKey);
      case "vertex": {
        const project = ctx.project ?? process.env.GOOGLE_CLOUD_PROJECT;
        const location =
          ctx.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
        if (!project) {
          console.log(
            pc.yellow(
              "\n  Set GOOGLE_CLOUD_PROJECT to list Vertex AI models.\n",
            ),
          );
          return [];
        }
        return await fetchVertexModels(
          project,
          location,
          ctx.vertexClientEmail,
          ctx.vertexPrivateKey,
        );
      }
    }
  } catch (e: any) {
    console.log(pc.red(`\n  Could not fetch models: ${e.message}\n`));
    return [];
  }
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

interface MenuOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  meta?: string;
}

function clearLastLines(count: number): void {
  for (let i = 0; i < count; i++) {
    process.stdout.write("\x1b[1A\x1b[2K\r");
  }
}

async function selectMenu<T extends string>(
  title: string,
  subtitle: string,
  options: MenuOption<T>[],
  initialIndex = 0,
): Promise<T> {
  if (!process.stdin.isTTY) {
    return options[Math.max(0, Math.min(initialIndex, options.length - 1))]!
      .value;
  }

  let selected = Math.max(0, Math.min(initialIndex, options.length - 1));
  let renderedLines = 0;
  const windowSize = 6;

  const render = () => {
    const start = Math.max(
      0,
      Math.min(
        selected - Math.floor(windowSize / 2),
        Math.max(0, options.length - windowSize),
      ),
    );
    const visible = options.slice(start, start + windowSize);

    const lines: string[] = [
      "",
      `${ANSI.bold}${ANSI.white}${title}${ANSI.reset}`,
      `${ANSI.gray}${subtitle}${ANSI.reset}`,
      "",
    ];

    if (start > 0) {
      lines.push(`${ANSI.gray}  ↑ ${start} more${ANSI.reset}`);
      lines.push("");
    }

    for (let i = 0; i < visible.length; i++) {
      const absoluteIndex = start + i;
      const option = visible[i]!;
      const active = absoluteIndex === selected;

      const pointer = active
        ? `${ANSI.cyan}›${ANSI.reset}`
        : `${ANSI.gray} ${ANSI.reset}`;

      const line =
        `${pointer} ${active ? `${ANSI.bold}${ANSI.white}${option.label}${ANSI.reset}` : `${ANSI.white}${option.label}${ANSI.reset}`}` +
        `${option.meta ? ` ${ANSI.gray}(${option.meta})${ANSI.reset}` : ""}`;

      lines.push(line);

      if (option.description) {
        lines.push(
          `  ${active ? `${ANSI.green}${option.description}${ANSI.reset}` : `${ANSI.gray}${option.description}${ANSI.reset}`}`,
        );
      }
    }

    if (start + visible.length < options.length) {
      lines.push("");
      lines.push(
        `${ANSI.gray}  ↓ ${options.length - (start + visible.length)} more${ANSI.reset}`,
      );
    }

    lines.push("");
    lines.push(
      `${ANSI.gray}↑/↓ navigate • enter select • esc cancel${ANSI.reset}`,
    );

    if (renderedLines > 0) {
      clearLastLines(renderedLines);
    }

    process.stdout.write(lines.join("\n") + "\n");
    renderedLines = lines.length;
  };

  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      if (renderedLines > 0) {
        clearLastLines(renderedLines);
        renderedLines = 0;
      }
    };

    const onData = (buffer: Buffer) => {
      const key = buffer.toString();

      if (key === "\u0003") {
        cleanup();
        process.stdout.write("\n");
        process.exit(0);
      }

      if (key === "\u001b[A") {
        selected = selected > 0 ? selected - 1 : options.length - 1;
        render();
        return;
      }

      if (key === "\u001b[B") {
        selected = selected < options.length - 1 ? selected + 1 : 0;
        render();
        return;
      }

      if (key === "\r") {
        const chosen = options[selected]!;
        cleanup();
        process.stdout.write(
          `${ANSI.green}✓${ANSI.reset} ${ANSI.white}${title}${ANSI.reset}: ${chosen.label}\n`,
        );
        resolve(chosen.value);
        return;
      }

      if (key === "\u001b") {
        cleanup();
        reject(new Error("Setup cancelled."));
        return;
      }

      const digit = Number.parseInt(key, 10);
      if (!Number.isNaN(digit) && digit >= 1 && digit <= options.length) {
        selected = digit - 1;
        render();
      }
    };

    render();

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function spinner(text: string): { stop: () => void } {
  const frames = ["", "", "", "", "", "", ""];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(
      `\r${ANSI.gray}${frames[i++ % frames.length]} ${text}${ANSI.reset}\x1b[K`,
    );
  }, 80);
  return {
    stop: () => {
      clearInterval(id);
      process.stdout.write(`\r\x1b[K`);
    },
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function padVisible(text: string, width: number): string {
  const pad = Math.max(0, width - visibleLength(text));
  return text + " ".repeat(pad);
}

function truncateVisible(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;

  let out = "";
  let visible = 0;
  let i = 0;

  while (i < text.length && visible < Math.max(0, width - 1)) {
    if (text[i] === "\x1b") {
      const match = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }

    out += text[i]!;
    visible++;
    i++;
  }

  return out + "…";
}

function normalizeCell(text: string, width: number): string {
  return padVisible(truncateVisible(text, width), width);
}

function setupWidth(): number {
  const columns = process.stdout.columns || 120;
  return Math.max(72, Math.min(columns - 2, 118));
}

function setupRule(width = setupWidth()): string {
  return `${ANSI.gray}${"─".repeat(width)}${ANSI.reset}`;
}

function setupBox(title: string, lines: string[], width = setupWidth()): void {
  const inner = Math.max(16, width - 4);
  const prefix =
    `${ANSI.gray}╭─ ${ANSI.reset}` +
    `${ANSI.cyan}${ANSI.bold}${title}${ANSI.reset}` +
    `${ANSI.gray} `;
  const fill = "─".repeat(Math.max(0, width - visibleLength(prefix) - 1));
  const top = `${prefix}${fill}╮${ANSI.reset}`;
  const bottom = `${ANSI.gray}╰${"─".repeat(width - 2)}╯${ANSI.reset}`;

  console.log(top);
  for (const line of lines) {
    console.log(
      `${ANSI.gray}│ ${ANSI.reset}${normalizeCell(line, inner)}${ANSI.gray} │${ANSI.reset}`,
    );
  }
  console.log(bottom);
}

function setupSection(title: string, subtitle?: string): void {
  console.log();
  console.log(`${ANSI.bold}${ANSI.white}${title}${ANSI.reset}`);
  if (subtitle) {
    console.log(`${ANSI.gray}${subtitle}${ANSI.reset}`);
  }
}

function setupHint(message: string): void {
  console.log(`${ANSI.gray}${message}${ANSI.reset}`);
}

function setupSuccess(message: string): void {
  console.log(`${ANSI.green}✓${ANSI.reset} ${message}`);
}

function setupWarn(message: string): void {
  console.log(
    `${ANSI.yellow}⚠${ANSI.reset} ${ANSI.yellow}${message}${ANSI.reset}`,
  );
}

function setupError(message: string): void {
  console.log(`${ANSI.red}✗${ANSI.reset} ${message}`);
}

function providerLabel(provider: Config["provider"]): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "azure":
      return "Azure OpenAI";
    case "google":
      return "Google AI";
    case "openai":
      return "OpenAI";
    case "openrouter":
      return "OpenRouter";
    case "ollama":
      return "Ollama";
    case "vertex":
      return "Vertex AI";
  }
}

function searchProviderLabel(provider: WebSearchProvider): string {
  switch (provider) {
    case "google":
      return "Google Custom Search";
    case "brave":
      return "Brave Search";
    case "tavily":
      return "Tavily Search";
  }
}

function isSearchProvider(value: unknown): value is WebSearchProvider {
  return (
    typeof value === "string" &&
    SEARCH_PROVIDERS.includes(value as WebSearchProvider)
  );
}

function maskSecret(value: string): string {
  if (!value) return "not set";
  if (value.length <= 12) return `${value.slice(0, 3)}••••${value.slice(-2)}`;
  return `${value.slice(0, 6)}••••${value.slice(-4)}`;
}

async function selectProvider(
  initialProvider?: Config["provider"],
  message?: string,
): Promise<Config["provider"]> {
  const providerDescriptions: Record<Config["provider"], string> = {
    anthropic: "Claude models for deep security reasoning and code review",
    azure: "Azure OpenAI deployments for enterprise-hosted model access",
    google: "Google Gemini models for broad analysis and fast iteration",
    openai: "OpenAI GPT models for security reviews and remediation guidance",
    openrouter: "Unified access to many hosted frontier and open models",
    ollama: "Local models running on your machine for private scanning",
    vertex: "Google Cloud Vertex AI with service-account authentication",
  };

  const options: MenuOption<Config["provider"]>[] = PROVIDERS.map(
    (provider) => ({
      value: provider,
      label: providerLabel(provider),
      description: providerDescriptions[provider],
      meta: provider,
    }),
  );

  return unwrapPrompt(
    await p.select({
      message:
        message ??
        (initialProvider
          ? `Choose the default backend (current: ${providerLabel(initialProvider)})`
          : "Choose the default backend"),
      options: options.map((option) => ({
        value: option.value,
        label: option.label,
        hint: option.description ?? option.meta,
      })),
    }),
  );
}

async function selectModel(
  models: ModelInfo[],
  currentModel?: string,
): Promise<string> {
  const display = models.slice(0, 30);
  const customValue = "__custom__";

  const options: MenuOption<string>[] = [
    ...display.map((m) => ({
      value: m.id,
      label: m.id,
      description:
        m.name !== m.id ? m.name : "Use this model for future scans by default",
      meta: "model",
    })),
    {
      value: customValue,
      label: "Enter custom model name",
      description: "Use a model identifier that is not listed above",
      meta: "custom",
    },
  ];

  const initialIndex = currentModel
    ? Math.max(
        0,
        options.findIndex((option) => option.value === currentModel),
      )
    : 0;

  const selected = unwrapPrompt(
    await p.select({
      message: currentModel
        ? `Pick the default model for scans (current: ${currentModel})`
        : "Pick the default model for scans",
      options: options.map((option) => ({
        value: option.value,
        label: option.label,
        hint: option.description ?? option.meta,
      })),
    }),
  );

  if (selected === customValue) {
    return await promptText("Custom model name", {
      initialValue: currentModel,
      validate: (value) =>
        value.trim().length === 0 ? "Model is required." : undefined,
    });
  }

  return selected;
}

async function configureProviderSettings(
  provider: Config["provider"],
  existing?: StoredConfig | null,
): Promise<ProviderSetupResult> {
  let apiKey = "";
  let resourceName: string | undefined;
  let project: string | undefined;
  let location: string | undefined;
  let vertexClientEmail: string | undefined;
  let vertexPrivateKey: string | undefined;

  p.log.step(`Authentication for ${providerLabel(provider)}`);

  if (provider === "vertex") {
    p.log.info(
      [
        "Vertex AI uses a Google Cloud service account JSON.",
        "Create or download a service account key, then provide the local JSON file path.",
        "Docs: https://console.cloud.google.com/iam-admin/serviceaccounts",
      ].join("\n"),
    );

    const saPath = await promptText("Service account JSON path", {
      placeholder: "~/.config/gcloud/service-account.json",
      validate: (value) =>
        value.trim().length === 0
          ? "Service account JSON path is required for Vertex AI."
          : undefined,
    });

    let saJson: {
      client_email?: string;
      private_key?: string;
      project_id?: string;
    };
    try {
      const saFile = Bun.file(saPath.replace(/^~/, homedir()));
      if (!(await saFile.exists())) {
        throw new Error(`File not found: ${saPath}`);
      }
      saJson = await saFile.json();
    } catch (e: any) {
      throw new Error(`Failed to read service account JSON: ${e.message}`);
    }

    if (!saJson.client_email || !saJson.private_key) {
      throw new Error(
        "Invalid service account JSON — missing client_email or private_key.",
      );
    }

    vertexClientEmail = saJson.client_email;
    vertexPrivateKey = saJson.private_key;

    project =
      saJson.project_id ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      (await promptText("Google Cloud project ID", {
        validate: (value) =>
          value.trim().length === 0
            ? "Project ID is required for Vertex AI."
            : undefined,
      }));
    if (!project) throw new Error("Project ID is required for Vertex AI.");

    location =
      (process.env.GOOGLE_CLOUD_LOCATION ??
        (await promptText("Location", {
          initialValue: existing?.location ?? "us-central1",
        }))) ||
      "us-central1";

    apiKey = "service-account";

    p.log.success(`Service account loaded: ${vertexClientEmail}`);
  } else if (provider === "azure") {
    const envKey = process.env.AZURE_API_KEY;

    if (envKey) {
      p.log.info(
        `Detected AZURE_API_KEY in your environment (${maskSecret(envKey)}).`,
      );
      const useEnv = await promptConfirm("Use the detected Azure API key?");
      apiKey = useEnv
        ? envKey
        : await promptSecret("Azure API key", (value) =>
            value.trim().length === 0 ? "API key is required." : undefined,
          );
    } else {
      apiKey = await promptSecret("Azure API key", (value) =>
        value.trim().length === 0 ? "API key is required." : undefined,
      );
    }
    if (!apiKey) throw new Error("API key is required.");

    resourceName =
      process.env.AZURE_RESOURCE_NAME ??
      (await promptText("Azure resource name", {
        validate: (value) =>
          value.trim().length === 0
            ? "Resource name is required for Azure OpenAI."
            : undefined,
      }));
    if (!resourceName) {
      throw new Error("Resource name is required for Azure OpenAI.");
    }

    p.log.success("Azure credentials captured.");
  } else {
    const envKey = process.env[API_KEY_ENV[provider]];

    if (envKey) {
      p.log.info(
        `Detected ${API_KEY_ENV[provider]} in your environment (${maskSecret(envKey)}).`,
      );
      const useEnv = await promptConfirm("Use the detected API key?");
      if (useEnv) {
        apiKey = envKey;
      } else {
        apiKey = await promptSecret(
          `${providerLabel(provider)} API key`,
          (value) =>
            value.trim().length === 0 ? "API key is required." : undefined,
        );
      }
    } else {
      apiKey = await promptSecret(
        `${providerLabel(provider)} API key`,
        (value) =>
          value.trim().length === 0 ? "API key is required." : undefined,
      );
    }

    if (!apiKey) {
      throw new Error("API key is required.");
    }

    p.log.success(`${providerLabel(provider)} credentials captured.`);
  }

  p.log.step("Model");
  const loading = p.spinner();
  loading.start("Fetching available models...");
  const models = await fetchModels(provider, apiKey, {
    resourceName,
    project,
    location,
    vertexClientEmail,
    vertexPrivateKey,
  });
  loading.stop(
    models.length > 0
      ? `Loaded ${Math.min(models.length, 30)} model options`
      : "Model lookup finished",
  );

  let model: string;

  if (models.length > 0) {
    model = await selectModel(
      models,
      existing?.provider === provider ? existing.model : undefined,
    );
  } else {
    p.log.warn(
      "Could not fetch models automatically. Enter a model name manually.",
    );
    model = await promptText("Model", {
      initialValue:
        existing?.provider === provider ? existing.model : undefined,
      validate: (value) =>
        value.trim().length === 0 ? "Model is required." : undefined,
    });
  }

  return {
    apiKey,
    model,
    provider,
    ...(resourceName ? { resourceName } : {}),
    ...(project ? { project } : {}),
    ...(location && location !== "us-central1" ? { location } : {}),
    ...(vertexClientEmail ? { vertexClientEmail } : {}),
    ...(vertexPrivateKey ? { vertexPrivateKey } : {}),
  };
}

interface WebSearchSetupResult {
  searchApiKey?: string;
  searchGoogleCx?: string;
  searchProvider?: WebSearchProvider;
}

async function configureWebSearch(
  existing?: StoredConfig | null,
): Promise<WebSearchSetupResult> {
  const provider = unwrapPrompt(
    await p.select({
      message: existing?.searchProvider
        ? `Choose a web search provider (current: ${searchProviderLabel(existing.searchProvider)})`
        : "Choose a web search provider",
      options: SEARCH_PROVIDERS.map((value) => ({
        value,
        label: searchProviderLabel(value),
        hint:
          value === "google"
            ? "Programmable Search Engine (requires API key + cx)"
            : value === "brave"
              ? "Brave independent web index"
              : "Fast AI-oriented search API",
      })),
      initialValue: existing?.searchProvider,
    }),
  );

  p.log.step(`Web search credentials (${searchProviderLabel(provider)})`);

  if (provider === "google") {
    p.log.info(
      [
        "Google Custom Search requires:",
        `- API key (${SEARCH_API_KEY_ENV.google})`,
        `- Programmable Search Engine ID (cx) (${GOOGLE_SEARCH_CX_ENV})`,
      ].join("\n"),
    );
  }

  const envKey = process.env[SEARCH_API_KEY_ENV[provider]];
  let searchApiKey = "";

  if (envKey) {
    p.log.info(
      `Detected ${SEARCH_API_KEY_ENV[provider]} (${maskSecret(envKey)}).`,
    );
    const useEnv = await promptConfirm("Use the detected search API key?");
    searchApiKey = useEnv
      ? envKey
      : await promptSecret(
          `${searchProviderLabel(provider)} API key`,
          (value) =>
            value.trim().length === 0 ? "API key is required." : undefined,
        );
  } else {
    searchApiKey = await promptSecret(
      `${searchProviderLabel(provider)} API key`,
      (value) =>
        value.trim().length === 0 ? "API key is required." : undefined,
    );
  }

  if (!searchApiKey) {
    throw new Error("Search API key is required.");
  }

  let searchGoogleCx: string | undefined;
  if (provider === "google") {
    const envCx = process.env[GOOGLE_SEARCH_CX_ENV];
    if (envCx) {
      p.log.info(`Detected ${GOOGLE_SEARCH_CX_ENV} (${envCx}).`);
      const useEnvCx = await promptConfirm(
        "Use the detected Programmable Search Engine ID (cx)?",
      );
      searchGoogleCx = useEnvCx
        ? envCx
        : await promptText("Programmable Search Engine ID (cx)", {
            initialValue:
              existing?.searchProvider === "google"
                ? existing.searchGoogleCx
                : undefined,
            validate: (value) =>
              value.trim().length === 0
                ? "cx is required for Google search."
                : undefined,
          });
    } else {
      searchGoogleCx = await promptText("Programmable Search Engine ID (cx)", {
        initialValue:
          existing?.searchProvider === "google"
            ? existing.searchGoogleCx
            : undefined,
        validate: (value) =>
          value.trim().length === 0
            ? "cx is required for Google search."
            : undefined,
      });
    }
  }

  p.log.success(`${searchProviderLabel(provider)} configured.`);

  return {
    searchProvider: provider,
    searchApiKey,
    ...(searchGoogleCx ? { searchGoogleCx } : {}),
  };
}

function printSetupSummary(stored: StoredConfig): void {
  const lines = [
    ...(stored.userName ? [`User: ${stored.userName}`] : []),
    `Provider: ${providerLabel(stored.provider)} (${stored.provider})`,
    `Model: ${stored.model}`,
    `Auth: ${
      stored.provider === "vertex"
        ? "Google service account"
        : `API key ${maskSecret(stored.apiKey)}`
    }`,
    ...(stored.resourceName ? [`Resource: ${stored.resourceName}`] : []),
    ...(stored.project ? [`Project: ${stored.project}`] : []),
    ...(stored.location ? [`Location: ${stored.location}`] : []),
    ...(stored.searchProvider
      ? [
          `Web search: ${searchProviderLabel(stored.searchProvider)} (${stored.searchProvider})`,
          `Search API key: ${maskSecret(stored.searchApiKey ?? "")}`,
          ...(stored.searchProvider === "google"
            ? [`Search engine ID (cx): ${stored.searchGoogleCx ?? "not set"}`]
            : []),
        ]
      : ["Web search: not configured"]),
    `Config: ${CONFIG_PATH}`,
  ];

  p.log.info(`Configuration saved\n${lines.join("\n")}`);
}

// first run startup
async function firstRunSetup(): Promise<StoredConfig> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Initial setup requires an interactive terminal. Run `crack-code --setup` in a TTY session.",
    );
  }

  const existing = await readStoredConfig();

  console.log();
  console.log(pc.cyan(CrackCodeLogo()));
  p.intro("Crack Code setup");
  p.log.info(
    [
      "Configure Crack Code for vulnerability scanning and agent-assisted code review.",
      "Your selections are saved to ~/.crack-code/config.json.",
      "Run `crack-code --setup` anytime to change them.",
    ].join("\n"),
  );

  p.log.step("Profile");
  const userName = await promptText("Your name", {
    initialValue: existing?.userName,
    placeholder: "Your name",
    validate: (value) =>
      value.trim().length === 0 ? "Your name is required." : undefined,
  });
  p.log.success(`Hello, ${userName}.`);

  p.log.step("Provider");
  const provider = await selectProvider(existing?.provider);
  p.log.success(`Selected ${providerLabel(provider)}.`);
  const providerSetup = await configureProviderSettings(provider, existing);
  p.log.step("Web search");
  const webSearchSetup = await configureWebSearch(existing);

  const stored: StoredConfig = {
    userName,
    ...providerSetup,
    ...webSearchSetup,
  };

  await writeStoredConfig(stored);

  printSetupSummary(stored);
  p.outro("Ready. Start scanning with `crack-code`.");

  return stored;
}

function buildSystemPrompt(
  cwd: string,
  allowEdits: boolean,
  userName?: string,
): string {
  const lines = [
    "You are Crack Code — an elite security-focused code analysis assistant running in the user's terminal.",
    "You think like a red-team attacker, reason like a threat modeler, and report like a staff-level security engineer.",
    ...(userName
      ? [
          "",
          `User: ${userName}`,
          "Address the user by name when it feels natural — not on every message.",
        ]
      : []),
    "",
    `Working directory: ${cwd}`,
    "",

    "## Mission",
    "Perform deep, evidence-based security audits of codebases.",
    "Uncover vulnerabilities, logic flaws, misconfigurations, and exploitable patterns.",
    "Never guess. Never hallucinate. Every claim must be grounded in code you have actually read.",
    "",

    "## Threat Coverage",
    "",
    "### Injection & Input Handling",
    "- SQL / NoSQL / LDAP / XPath injection",
    "- OS command injection and argument injection",
    "- XSS (reflected, stored, DOM-based)",
    "- Path traversal and directory traversal",
    "- Template injection (SSTI)",
    "- HTTP header injection and response splitting",
    "",
    "### Authentication & Authorization",
    "- Broken authentication flows (weak passwords, missing lockout, enumeration)",
    "- Insecure session management (non-expiring tokens, no rotation, fixation)",
    "- Missing or bypassable authorization checks (IDOR, privilege escalation)",
    "- JWT vulnerabilities (alg:none, weak secrets, missing validation)",
    "- OAuth/OIDC misconfigurations",
    "",
    "### Cryptography & Secrets",
    "- Hardcoded secrets, API keys, tokens, passwords in source or config",
    "- Weak or broken algorithms (MD5, SHA1 for passwords, ECB mode, DES)",
    "- Insufficient entropy or predictable random number generation",
    "- Missing encryption at rest or in transit",
    "- Improper certificate validation (TLS pinning bypass, hostname ignored)",
    "",
    "### Application Logic",
    "- Business logic flaws (price manipulation, workflow bypass, state abuse)",
    "- Race conditions and TOCTOU (time-of-check/time-of-use) bugs",
    "- Mass assignment and parameter pollution",
    "- Unsafe deserialization and object injection",
    "- Insecure direct object references",
    "",
    "### Infrastructure & Configuration",
    "- Insecure defaults (debug mode on, verbose errors, open CORS, permissive CSP)",
    "- Dangerous dependency versions (known CVEs)",
    "- Overly permissive file or IAM permissions",
    "- Exposed admin endpoints, dev routes, or debug APIs",
    "- Misconfigured cloud storage (public S3 buckets, unauthenticated blobs)",
    "",
    "### Memory & Runtime Safety (where applicable)",
    "- Buffer overflows, heap/stack corruption",
    "- Use-after-free, double-free",
    "- Integer overflow / underflow",
    "- Null pointer dereferences in security-sensitive paths",
    "",
    "### Web-Specific Attacks",
    "- SSRF (internal network access, cloud metadata exposure)",
    "- CSRF (missing or bypassable tokens)",
    "- Open redirects and unvalidated redirects",
    "- Clickjacking (missing frame protection headers)",
    "- Subdomain takeover indicators",
    "",
    "### Information Leakage",
    "- Verbose error messages exposing stack traces, internal paths, or SQL",
    "- Sensitive data in logs, comments, or version control",
    "- Leaky APIs (over-fetching fields, hidden fields exposed)",
    "- Timing side-channels in authentication or comparison logic",
    "",

    "## Audit Methodology",
    "1. **Reconnaissance** — map the project structure, entry points, frameworks, and dependencies before touching any findings.",
    "2. **Triage** — identify the highest-risk surfaces first (auth, payments, file upload, external input).",
    "3. **Deep Read** — read the actual source. Line numbers must match real code.",
    "4. **Cross-Reference** — trace data flows from input to sink; don't stop at one layer.",
    "5. **Validate** — if uncertain about a finding, say so explicitly. Mark it UNCONFIRMED rather than inflating confidence.",
    "",

    "## Report Format",
    "Output findings in descending severity order. For each finding:",
    "",
    "**[SEVERITY] Short Title**",
    "- **File & Lines:** exact path and line range",
    "- **Vulnerable Code:** the actual problematic snippet (no paraphrasing)",
    "- **Root Cause:** why this is dangerous and what property it violates",
    "- **Attack Scenario:** realistic exploitation steps an adversary would follow",
    "- **Impact:** confidentiality / integrity / availability consequences",
    "- **Fix:** complete corrected code (not pseudocode, not a diff — working code)",
    "- **AI Fix Prompt:** a self-contained, copy-pasteable prompt an AI coding agent can use to apply the fix autonomously",
    "",

    "## Severity Rubric",
    "- **CRITICAL** — remote code execution, authentication bypass, data exfiltration with no user interaction",
    "- **HIGH** — significant data exposure, privilege escalation, exploitable with low effort",
    "- **MEDIUM** — requires some conditions or user interaction; meaningful risk if chained",
    "- **LOW** — defense-in-depth gaps, minor info leakage, best-practice violations",
    "- **INFO** — style, dead code, non-exploitable observations worth noting",
    "",

    "## Hard Rules",
    "- Read before you claim. Never fabricate file contents or line numbers.",
    "- No false positives. Uncertain findings must be flagged as UNCONFIRMED.",
    "- Complete fixes only. Show the full corrected function or block, not a fragment.",
    "- No remediation theater. Don't suggest cosmetic changes that don't address the root cause.",
    "- Stay in scope. Only report on the codebase provided unless a dependency CVE is directly exploitable.",
  ];

  if (!allowEdits) {
    lines.push(
      "",
      "## Mode: READ-ONLY",
      "You are in read-only mode. You may read files and run non-destructive commands.",
      "Do NOT write files or run commands that modify the filesystem.",
      "Show fixes as code suggestions only.",
    );
  } else {
    lines.push(
      "",
      "## Mode: EDIT ENABLED",
      "The user has enabled edits. You may apply fixes directly when asked.",
      "Always show the fix and get confirmation before writing.",
    );
  }

  return lines.join("\n");
}

export async function loadConfig(
  overrides: ConfigOverrides = {},
): Promise<Config> {
  let stored = await readStoredConfig();
  if (!stored) {
    stored = await firstRunSetup();
  }

  const provider = (overrides.provider ??
    stored.provider) as Config["provider"];
  if (!PROVIDERS.includes(provider)) {
    throw new Error(
      `Unknown provider "${provider}". Use: ${PROVIDERS.join(", ")}`,
    );
  }

  const envKey = API_KEY_ENV[provider];
  const apiKey =
    overrides.apiKey ??
    stored.apiKey ??
    (envKey ? process.env[envKey] : undefined);
  if (!apiKey && provider !== "vertex") {
    throw new Error(`No API key found. Run: crack-code --setup`);
  }

  const model = overrides.model ?? stored.model;
  const allowEdits = overrides.allowEdits ?? stored.allowEdits ?? false;
  const cwd = process.cwd();
  const searchProvider = isSearchProvider(stored.searchProvider)
    ? stored.searchProvider
    : undefined;
  const searchApiKey =
    searchProvider &&
    (stored.searchApiKey ?? process.env[SEARCH_API_KEY_ENV[searchProvider]]);
  const searchGoogleCx =
    searchProvider === "google"
      ? (stored.searchGoogleCx ?? process.env[GOOGLE_SEARCH_CX_ENV])
      : undefined;

  return {
    userName: stored.userName,
    provider,
    model,
    apiKey: apiKey ?? "",
    resourceName: stored.resourceName ?? process.env.AZURE_RESOURCE_NAME,
    project: stored.project ?? process.env.GOOGLE_CLOUD_PROJECT,
    location:
      stored.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
    vertexClientEmail: stored.vertexClientEmail,
    vertexPrivateKey: stored.vertexPrivateKey,
    maxTokens: overrides.maxTokens ?? 16384,
    maxSteps: overrides.maxSteps ?? 30,
    permissionPolicy: overrides.permissionPolicy ?? "ask",
    allowEdits,
    systemPrompt: buildSystemPrompt(cwd, allowEdits, stored.userName),
    scanPatterns: overrides.scanPatterns ?? DEFAULT_SCAN_PATTERNS,
    ignorePatterns: overrides.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS,
    cwd,
    searchProvider,
    searchApiKey,
    searchGoogleCx,
  };
}

export async function runSetup(): Promise<void> {
  await firstRunSetup();
}

export async function runProviderSetup(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Provider setup requires an interactive terminal. Run it in a TTY session.",
    );
  }

  const existing = await readStoredConfig();
  if (!existing) {
    await firstRunSetup();
    return;
  }

  const provider = await selectProvider(
    existing.provider,
    existing.provider
      ? `Choose a provider (current: ${providerLabel(existing.provider)})`
      : "Choose a provider",
  );
  p.log.success(`Selected ${providerLabel(provider)}.`);

  const providerSetup = await configureProviderSettings(provider, existing);
  const stored: StoredConfig = {
    ...existing,
    ...providerSetup,
  };

  await writeStoredConfig(stored);
  printSetupSummary(stored);
  p.outro(`Provider updated: ${providerLabel(provider)}.`);
}

export async function updateStoredConfig(
  updates: Partial<StoredConfig>,
): Promise<void> {
  const existing = (await readStoredConfig()) ?? ({} as StoredConfig);
  const merged = { ...existing, ...updates };
  await writeStoredConfig(merged);
  p.log.success("Config updated");
}
