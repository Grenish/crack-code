#!/usr/bin/env bun

import {
  isSetupCancelledError,
  loadConfig,
  runSetup,
  type Config,
  type ConfigOverrides,
} from "./config.js";
import { getModel, buildProviderOptions } from "./providers.js";
import { ToolRegistry } from "./tools/registry.js";
import {
  PermissionManager,
  type PermissionPolicy,
} from "./permissions/index.js";
import { readFileTool } from "./tools/file-read.js";
import { writeFileTool } from "./tools/file-write.js";
import { runCommandTool } from "./tools/shell.js";
import { listFilesTool } from "./tools/glob.js";
import { virtualTerminalTool } from "./tools/virtual-terminal.js";
import { createWebSearchTool } from "./tools/web-search.js";
import { runAgent } from "./agent.js";
import { startRepl } from "./repl.js";
import * as ui from "./ui/renderer.js";
import { APP_VERSION } from "./version.js";

// Version

// Help

function printHelp(): void {
  console.log(`
\x1b[1m\x1b[36mCrack Code\x1b[0m \x1b[90mv${APP_VERSION}\x1b[0m
AI-powered vulnerability scanning CLI for security-focused code review.

\x1b[1mUsage:\x1b[0m
  crack-code [options] [prompt]

\x1b[1mCommon workflows:\x1b[0m
  crack-code
      Launch the interactive security TUI

  crack-code "scan for vulnerabilities"
      Run a one-shot audit over the current codebase

  crack-code --scan "src/auth/**/*.ts" "check for auth flaws"
      Focus the scan on a high-risk area

  crack-code --allow-edits "fix the unsafe shell command usage"
      Allow the agent to propose and apply remediations

\x1b[1mOptions:\x1b[0m
  -i, --interactive          Force interactive TUI mode
  --setup                    Open the provider and model setup wizard
  --allow-edits              Enable file writing (read-only by default)
  --provider <name>          Override provider (anthropic, azure, google, openai, openrouter, ollama, vertex)
  --model <name>             Override model
  --key <key>                Override API key
  --policy <policy>          Permission policy (ask, skip, allow-all, deny-all)
  --scan <glob>              Only scan files matching this pattern
  --max-steps <n>            Max agent steps (default: 30)
  --max-tokens <n>           Max tokens per response (default: 16384)
  -h, --help                 Show this help
  -v, --version              Show version

\x1b[1mInteractive commands:\x1b[0m
  /help       Show commands        /clear      Clear history
  /exit       Exit                 /permission   Choose edit mode
  /usage      Token usage          /model      Show model info
  /policy     Show/set policy      /compact    Reduce context size
  /marketplace   Community tools
`);
}

// Arg Parsing

interface ParsedArgs {
  flags: Record<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  const booleanFlags = new Set([
    "help",
    "h",
    "version",
    "v",
    "interactive",
    "i",
    "setup",
    "allow-edits",
    "yolo",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (booleanFlags.has(key)) {
        flags[key] = "true";
      } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        flags[key] = argv[++i]!;
      } else {
        flags[key] = "true";
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      if (booleanFlags.has(key)) {
        flags[key] = "true";
      } else if (i + 1 < argv.length) {
        flags[key] = argv[++i]!;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

// Tool Registration

function registerTools(config: Config): ToolRegistry {
  const tools = new ToolRegistry();

  // Always available — read-only tools
  tools.register(readFileTool);
  tools.register(listFilesTool);

  // Shell is always available but goes through permission gate
  tools.register(runCommandTool);

  // Virtual terminal — persistent context across commands
  tools.register(virtualTerminalTool);

  // Optional web search tool (enabled when provider credentials are configured)
  if (config.searchProvider && config.searchApiKey) {
    if (config.searchProvider !== "google" || config.searchGoogleCx) {
      tools.register(createWebSearchTool(config));
    } else {
      ui.warn(
        "Web search is disabled: Google search provider requires a Programmable Search Engine ID (cx). Run `crack-code --setup`.",
      );
    }
  }

  // Write tools only when edits are enabled
  if (config.allowEdits) {
    tools.register(writeFileTool);
  }

  return tools;
}

// Main

async function main(): Promise<void> {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  // Early exits

  if (flags.help || flags.h) {
    printHelp();
    process.exit(0);
  }

  if (flags.version || flags.v) {
    console.log(`crack-code v${APP_VERSION}`);
    process.exit(0);
  }

  if (flags.setup) {
    try {
      await runSetup();
      process.exit(0);
    } catch (e: any) {
      if (isSetupCancelledError(e)) {
        process.exit(0);
      }
      ui.error(e.message);
      process.exit(1);
    }
  }

  // Build config overrides from flags

  const overrides: ConfigOverrides = {};

  if (flags.provider) overrides.provider = flags.provider;
  if (flags.model) overrides.model = flags.model;
  if (flags.key) overrides.apiKey = flags.key;
  if (flags["max-tokens"])
    overrides.maxTokens = parseInt(flags["max-tokens"], 10);
  if (flags["max-steps"]) overrides.maxSteps = parseInt(flags["max-steps"], 10);
  if (flags["allow-edits"]) overrides.allowEdits = true;
  if (flags.scan) overrides.scanPatterns = [flags.scan];

  if (flags.yolo) {
    overrides.permissionPolicy = "allow-all";
  } else if (flags.policy) {
    overrides.permissionPolicy =
      flags.policy as ConfigOverrides["permissionPolicy"];
  }

  // Load config (may trigger first-run wizard)

  let config;
  try {
    config = await loadConfig(overrides);
  } catch (e: any) {
    if (isSetupCancelledError(e)) {
      process.exit(0);
    }
    ui.error(e.message);
    process.exit(1);
  }

  // Create provider model

  let model;
  try {
    model = getModel(config);
  } catch (e: any) {
    ui.error(e.message);
    process.exit(1);
  }

  // Register tools

  const tools = registerTools(config);

  // Create permission manager

  const permissions = new PermissionManager(
    config.permissionPolicy,
    config.allowEdits,
  );

  // Route: one-shot vs REPL

  const hasPrompt = positional.length > 0;
  const forceInteractive = flags.interactive || flags.i;
  const isPiped = !process.stdin.isTTY;

  if (hasPrompt && !forceInteractive) {
    // One-shot mode
    await runOneShot(positional.join(" "), model, config, tools, permissions);
  } else if (isPiped) {
    // Piped input: cat file.ts | crack-code
    await runPiped(model, config, tools, permissions);
  } else {
    // Interactive REPL
    await startRepl(model, config, tools, permissions);
  }
}

// ─── One-Shot Mode ──────────────────────────────────────────────────

async function runOneShot(
  prompt: string,
  model: any,
  config: any,
  tools: ToolRegistry,
  permissions: PermissionManager,
): Promise<void> {
  ui.newline();

  const loading = ui.spinner("Analyzing...");
  let firstToken = true;

  try {
    await runAgent(
      [{ role: "user" as const, content: prompt }],
      {
        model,
        tools,
        permissions,
        systemPrompt: config.systemPrompt,
        maxSteps: config.maxSteps,
        maxTokens: config.maxTokens,
        providerOptions: buildProviderOptions(config),
      },
      {
        onReasoning: (delta) => {
          if (firstToken) {
            loading.stop();
            firstToken = false;
            console.log("\x1b[2m🤔 Thinking...\x1b[0m");
          }
          ui.streamReasoning(delta);
        },
        onText: (delta) => {
          if (firstToken) {
            loading.stop();
            firstToken = false;
          }
          ui.streamText(delta);
        },

        onToolStart: (name, args) => {
          if (firstToken) {
            loading.stop();
            firstToken = false;
          }
          ui.toolStart(name, args);
        },

        onToolEnd: (name, result) => {
          ui.toolEnd(name, result);
        },

        onUsage: (usage) => {
          ui.newline();
          ui.dim(
            `  [${usage.inputTokens} input + ${usage.outputTokens} output = ${usage.totalTokens} tokens]`,
          );
        },

        onError: (err) => {
          loading.stop();
          ui.error(err);
        },
      },
    );

    if (firstToken) loading.stop();
    ui.newline();
  } catch (e: any) {
    loading.stop();
    ui.error(e.message);
    process.exit(1);
  }
}

// ─── Piped Mode ─────────────────────────────────────────────────────

async function runPiped(
  model: any,
  config: any,
  tools: ToolRegistry,
  permissions: PermissionManager,
): Promise<void> {
  const chunks: string[] = [];

  const reader = process.stdin as unknown as AsyncIterable<Buffer>;
  for await (const chunk of reader) {
    chunks.push(chunk.toString());
  }

  const input = chunks.join("").trim();

  if (!input) {
    ui.error("No input received from pipe.");
    process.exit(1);
  }

  const prompt = [
    "Analyze the following code for security vulnerabilities:\n",
    "```",
    input,
    "```",
  ].join("\n");

  await runOneShot(prompt, model, config, tools, permissions);
}

// ─── Run ─────────────────────────────────────────────────────────────

main().catch((e) => {
  ui.error(e.message ?? String(e));
  process.exit(1);
});
