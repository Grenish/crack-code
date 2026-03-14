import { mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
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
import { pastel } from "gradient-string";

export interface Config {
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

async function fetchModels(
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

function spinner(text: string): { stop: () => void } {
  const frames = ["", "", "", "", "", "", ""];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(
      `\r\x1b[90m${frames[i++ % frames.length]} ${text}\x1b[0m`,
    );
  }, 80);
  return {
    stop: () => {
      clearInterval(id);
      process.stdout.write(`\r\x1b[K`); // clear line
    },
  };
}

// first run startup
async function firstRunSetup(): Promise<StoredConfig> {
  console.log(pastel(CrackCodeLogo()), "\n");
  console.log("This will be saved to ~/.crack-code/config.json\n");
  console.log("You can change it anytime with: crack-code --setup");

  // Provider setup
  console.log("\x1b[1mSelect a provider:\x1b[0m");
  PROVIDERS.forEach((p, i) => {
    console.log(`  \x1b[36m${i + 1}\x1b[0m) ${p}`);
  });

  let providerIdx = 0;
  while (true) {
    const answer = await prompt("\nProvider [1]: ");
    providerIdx = answer ? parseInt(answer, 10) - 1 : 0;
    if (providerIdx >= 0 && providerIdx < PROVIDERS.length) break;
    console.log("\x1b[31mInvalid choice.\x1b[0m");
  }
  const provider = PROVIDERS[providerIdx]!;

  // Provider-specific credential gathering
  let apiKey = "";
  let resourceName: string | undefined;
  let project: string | undefined;
  let location: string | undefined;

  // Vertex service account fields (populated below if provider is vertex)
  let vertexClientEmail: string | undefined;
  let vertexPrivateKey: string | undefined;

  if (provider === "vertex") {
    // Vertex uses a service account JSON for authentication
    console.log(
      "\n\x1b[90mVertex AI authenticates via a Google Cloud service account JSON.\x1b[0m",
    );
    console.log(
      "\x1b[90mYou can get one from: https://console.cloud.google.com/iam-admin/serviceaccounts\x1b[0m",
    );
    console.log(
      "\x1b[90mCreate a key (JSON) for the service account and paste the file path below.\x1b[0m\n",
    );

    const saPath = await prompt("Path to service account JSON file: ");
    if (!saPath)
      throw new Error("Service account JSON path is required for Vertex AI.");

    // Read and parse the service account JSON
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

    // Use project_id from the JSON if available, otherwise ask
    project =
      saJson.project_id ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      (await prompt("\nGoogle Cloud project ID: "));
    if (!project) throw new Error("Project ID is required for Vertex AI.");

    location =
      (process.env.GOOGLE_CLOUD_LOCATION ??
        (await prompt("Location [us-central1]: "))) ||
      "us-central1";

    // Use a placeholder — Vertex authenticates via service account, not a pasted key
    apiKey = "service-account";

    console.log(pc.green(`\n✓ Service account loaded: ${vertexClientEmail}`));
  } else if (provider === "azure") {
    // Azure needs both an API key and a resource name
    const envKey = process.env.AZURE_API_KEY;

    if (envKey) {
      const masked = envKey.slice(0, 8) + "..." + envKey.slice(-4);
      const useEnv = await prompt(
        `\nFound AZURE_API_KEY (${masked}). Use it? [Y/n]: `,
      );
      apiKey =
        !useEnv || useEnv.toLowerCase() === "y"
          ? envKey
          : await prompt("Enter Azure API key: ");
    } else {
      apiKey = await prompt("\nEnter your Azure API key: ");
    }
    if (!apiKey) throw new Error("API key is required.");

    resourceName =
      process.env.AZURE_RESOURCE_NAME ??
      (await prompt("Azure resource name: "));
    if (!resourceName)
      throw new Error("Resource name is required for Azure OpenAI.");
  } else {
    // Standard providers — single API key
    const envKey = process.env[API_KEY_ENV[provider]];

    if (envKey) {
      const masked = envKey.slice(0, 8) + "..." + envKey.slice(-4);
      const useEnv = await prompt(
        `\nFound ${API_KEY_ENV[provider]} (${masked}). Use it? [Y/n]: `,
      );
      if (!useEnv || useEnv.toLowerCase() === "y") {
        apiKey = envKey;
      } else {
        apiKey = await prompt("Enter API key: ");
      }
    } else {
      apiKey = await prompt(`\nEnter your ${provider} API key: `);
    }

    if (!apiKey) {
      throw new Error("API key is required.");
    }
  }

  const loading = spinner("Fetching available models...");
  const models = await fetchModels(provider, apiKey, {
    resourceName,
    project,
    location,
    vertexClientEmail,
    vertexPrivateKey,
  });
  loading.stop();

  let model: string;

  if (models.length > 0) {
    console.log(`\n\x1b[1mAvailable models:\x1b[0m`);

    // Show paginated if too many
    const display = models.slice(0, 30);
    display.forEach((m, i) => {
      const label =
        m.name !== m.id ? `${m.id} \x1b[90m(${m.name})\x1b[0m` : m.id;
      console.log(`  \x1b[36m${String(i + 1).padStart(2)}\x1b[0m) ${label}`);
    });
    if (models.length > 30) {
      console.log(
        `\x1b[90m  ... and ${models.length - 30} more. Enter a custom name to use unlisted models.\x1b[0m`,
      );
    }
    console.log(
      `  \x1b[36m ${display.length + 1}\x1b[0m) Enter custom model name`,
    );

    while (true) {
      const answer = await prompt(`\nModel [1]: `);
      const idx = answer ? parseInt(answer, 10) - 1 : 0;

      if (!isNaN(idx) && idx >= 0 && idx < display.length) {
        model = display[idx]!.id;
        break;
      } else if (idx === display.length) {
        model = await prompt("Enter model name: ");
        if (model) break;
      } else if (answer && isNaN(parseInt(answer, 10))) {
        // User typed a model name directly
        model = answer;
        break;
      }
      console.log("\x1b[31mInvalid choice.\x1b[0m");
    }
  } else {
    // Fallback — API fetch failed, ask for manual input
    console.log(
      "\n\x1b[33mCouldn't fetch models. Enter a model name manually.\x1b[0m",
    );
    model = await prompt("Model: ");
    if (!model) {
      throw new Error("Model is required.");
    }
  }
  const stored: StoredConfig = {
    provider,
    model,
    apiKey,
    ...(resourceName ? { resourceName } : {}),
    ...(project ? { project } : {}),
    ...(location && location !== "us-central1" ? { location } : {}),
    ...(vertexClientEmail ? { vertexClientEmail } : {}),
    ...(vertexPrivateKey ? { vertexPrivateKey } : {}),
  };
  await writeStoredConfig(stored);

  console.log(`\n\x1b[32m✓ Saved: provider=${provider}, model=${model}\x1b[0m`);
  console.log(`\x1b[90m  ${CONFIG_PATH}\x1b[0m\n`);

  return stored;
}

function buildSystemPrompt(cwd: string, allowEdits: boolean): string {
  const lines = [
    "You are Crack Code — a security-focused code analysis assistant running in the user's terminal.",
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
    systemPrompt: buildSystemPrompt(cwd, allowEdits),
    scanPatterns: overrides.scanPatterns ?? DEFAULT_SCAN_PATTERNS,
    ignorePatterns: overrides.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS,
    cwd,
  };
}

export async function runSetup(): Promise<void> {
  await firstRunSetup();
}

export async function updateStoredConfig(
  updates: Partial<StoredConfig>,
): Promise<void> {
  const existing = (await readStoredConfig()) ?? ({} as StoredConfig);
  const merged = { ...existing, ...updates };
  await writeStoredConfig(merged);
  console.log(`\x1b[32m✓ Config updated\x1b[0m`);
}
