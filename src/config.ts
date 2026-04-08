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
}

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
      validate: validate
        ? (value) => validate(value ?? "")
        : undefined,
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
      validate: validate
        ? (value) => validate(value ?? "")
        : undefined,
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
        apiKey = await promptSecret(`${providerLabel(provider)} API key`, (
          value,
        ) => (value.trim().length === 0 ? "API key is required." : undefined));
      }
    } else {
      apiKey = await promptSecret(`${providerLabel(provider)} API key`, (
        value,
      ) => (value.trim().length === 0 ? "API key is required." : undefined));
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
    model = await selectModel(models, existing?.provider === provider ? existing.model : undefined);
  } else {
    p.log.warn(
      "Could not fetch models automatically. Enter a model name manually.",
    );
    model = await promptText("Model", {
      initialValue: existing?.provider === provider ? existing.model : undefined,
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

  const stored: StoredConfig = {
    userName,
    ...providerSetup,
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
    "You are Crack Code — a security-focused code analysis assistant running in the user's terminal.",
    ...(userName
      ? [
          "",
          `User: ${userName}`,
          "Address the user by name when it is natural and helpful.",
        ]
      : []),
    "",
    `Working directory: ${cwd}`,
    "",
    "## Your Role",
    "Analyze codebases to find security vulnerabilities, bugs, logic flaws, and potential exploits.",
    "You think like an attacker but report like a senior security engineer.",
    "",
    "## What You Look For",
    "- Injection vulnerabilities (SQL, XSS, command injection, path traversal)",
    "- Authentication & authorization flaws",
    "- Hardcoded secrets, API keys, credentials",
    "- Insecure cryptography or hashing",
    "- Race conditions and TOCTOU bugs",
    "- Unsafe deserialization",
    "- Missing input validation and sanitization",
    "- Insecure dependencies or configurations",
    "- Business logic flaws",
    "- Information leakage (error messages, stack traces, debug endpoints)",
    "- SSRF, CSRF, open redirects",
    "- Improper error handling",
    "- Memory safety issues (buffer overflows, use-after-free) where applicable",
    "",
    "## How You Report",
    "For each finding:",
    "1. **Severity** — CRITICAL / HIGH / MEDIUM / LOW / INFO",
    "2. **File & Line** — exact location",
    "3. **Vulnerable Code** — show the actual problematic code",
    "4. **Explanation** — what the vulnerability is and why it matters",
    "5. **Attack Scenario** — how an attacker could exploit this",
    "6. **Fix** — concrete code showing the remediation",
    "",
    "## Rules",
    "- Always read the actual source files before making claims. Never guess.",
    "- Start by understanding the project structure (list files, read configs).",
    "- Prioritize findings by severity. CRITICAL and HIGH first.",
    "- Be precise. Cite exact file paths and line numbers.",
    "- No false positives. If you're unsure, say so.",
    "- When showing fixes, show complete corrected code, not just diffs.",
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
