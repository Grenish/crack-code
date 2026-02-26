#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────
// Wires together all modules into the interactive CLI:
//
//   1. CLI flag parsing (--version, --help)
//   2. First-run wizard (configuration setup)
//   3. Provider bootstrap (register + initialize AI provider)
//   4. Session tracking (metrics, exit handler)
//   5. MCP setup (optional web search servers)
//   6. Agent creation (AI agent with tool use)
//   7. Dashboard rendering (HUD)
//   8. Interactive REPL loop (commands + agent conversation)
//
// Zero external dependencies — built on Node built-ins and project modules.
// ─────────────────────────────────────────────────────────────────────────────

import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import { resolve, basename } from "node:path";
import { readdirSync, statSync } from "node:fs";

// ── Utils ───────────────────────────────────────────────────────────────────

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
  magenta,
  stripAnsi,
  SHIELD_ICON,
  CHECK_MARK,
  CROSS_MARK,
  WARNING_MARK,
  GEAR_ICON,
  SEARCH_ICON,
  setIconMode,
  getIconMode,
  type IconMode,
} from "./utils/colors.js";

import {
  APP_NAME,
  APP_VERSION,
  APP_DESCRIPTION,
  COMMANDS,
  EXIT_CODES,
} from "./utils/constants.js";

// ── Config ──────────────────────────────────────────────────────────────────

import {
  type CrackCodeConfig,
  saveConfig,
  setDisplay,
  getEffectiveApiKey,
  getEffectiveBaseUrl,
  getProviderLabel,
  setLastScanPath,
} from "./config/index.js";

// ── TUI ─────────────────────────────────────────────────────────────────────

import { ensureWizardCompleted, runConfigEditor } from "./tui/wizard.js";

import {
  renderHelpScreen,
  renderStatusScreen,
  renderToolsScreen,
  createDefaultDashboardInfo,
  updateDashboardProvider,
  updateDashboardScans,
  updateDashboardMCP,
  detectGitStatus,
  type DashboardInfo,
  type GitStatus,
} from "./tui/dashboard.js";

import {
  printBlank,
  printError,
  printSuccess,
  printInfo,
  printWarning,
  withSpinner,
  selectOption,
  type SelectChoice,
} from "./tui/prompt.js";

// ── Session ─────────────────────────────────────────────────────────────────

import { createSession, getSession } from "./cli/session.js";

// ── Providers ───────────────────────────────────────────────────────────────

import {
  registerAllBuiltinProviders,
  bootstrapProvider,
  checkProviderHealth,
} from "./providers/registry.js";

import type { BaseProvider, StreamDelta } from "./providers/base.js";

// ── Agent ───────────────────────────────────────────────────────────────────

import {
  createAgent,
  parseTargetMentions,
  buildTargetContext,
  type AgentConfig,
  type Agent,
} from "./agent/index.js";

// ── Tools ───────────────────────────────────────────────────────────────────

import { getBuiltinToolSummary } from "./tools/builtin/index.js";

// ── Scanner & Analyzer ─────────────────────────────────────────────────────

import { scanProject, type ScanResult } from "./scanner/index.js";
import { analyzeProject, type AnalysisResult } from "./analyzer/index.js";

// ── Output ──────────────────────────────────────────────────────────────────

import {
  formatScanSummary,
  formatFindingsList,
  formatFullReport,
  formatAgentResponse,
  formatAgentError,
  formatNoFindings,
  formatToolCallCompact,
  formatToolResultCompact,
  formatThinkingSpinner,
  formatProgressIndicator,
  type ScanSummaryInput,
} from "./output/formatter";
import { StreamRenderer } from "./output/stream-renderer";

let currentStreamRenderer: StreamRenderer | null = null;

import {
  countBySeverity,
  countByCategory,
  getAffectedFiles,
} from "./output/findings.js";
import { generateAndWriteReport, type ReportMeta } from "./output/report.js";

// ── MCP ─────────────────────────────────────────────────────────────────────

import { createMCPCallFunction, type MCPClient } from "./mcp/client.js";

// ═════════════════════════════════════════════════════════════════════════════
// ASCII Art Banner (matches ui.md spec)
// ═════════════════════════════════════════════════════════════════════════════

const CRACK_CODE_BANNER = [
  `_________                       __     _________            .___      `,
  `\\_   ___ \\____________    ____ |  | __ \\_   ___ \\  ____   __| _/____  `,
  `/    \\  \\/\\_  __ \\__  \\ _/ ___\\|  |/ / /    \\  \\/ /  _ \\ / __ |/ __ \\ `,
  `\\     \\____|  | \\// __ \\\\  \\___|    <  \\     \\___(  <_> ) /_/ \\  ___/ `,
  ` \\______  /|__|  (____  /\\___  >__|_ \\  \\______  /\\____/\\____ |\\___  >`,
  `        \\/            \\/     \\/     \\/         \\/            \\/    \\/ `,
];

function renderBannerString(): string {
  const lines: string[] = [];
  const colors = [brightCyan, cyan, brightGreen, green, brightCyan, cyan];
  for (let i = 0; i < CRACK_CODE_BANNER.length; i++) {
    const colorFn = colors[i % colors.length]!;
    lines.push(colorFn(CRACK_CODE_BANNER[i]!));
  }
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// Path Helper
// ═════════════════════════════════════════════════════════════════════════════

/** Shorten an absolute path by replacing $HOME with ~ */
function shortenPath(p: string): string {
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

/** Get terminal width, clamped */
function getTermWidth(): number {
  return Math.max(40, (process.stdout as NodeJS.WriteStream).columns || 80);
}

// ═════════════════════════════════════════════════════════════════════════════
// Startup Dashboard (ui.md Fig. 2)
// ═════════════════════════════════════════════════════════════════════════════

function renderStartupDashboard(
  config: CrackCodeConfig,
  targetPath: string,
  git: GitStatus,
  modelName: string,
): string {
  const lines: string[] = [];
  const width = getTermWidth();

  // Clear screen + home
  lines.push("\x1B[2J\x1B[H");

  // ── Banner ─────────────────────────────────────────────────────────
  lines.push(renderBannerString());

  // ── Meta info block (aligned labels) ───────────────────────────────
  //    version: 0.1.0
  //      Host: grenishrai
  //      Repo: /home/grenishrai/Desktop/apps/crack-code
  //       Git: True ( main )
  const hostName = config.display.hostName || "User";
  const homeDir = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  const isHomeDir = targetPath === homeDir || targetPath === homeDir + "/";

  lines.push(`${dim("version:")} ${white(APP_VERSION)}`);
  lines.push(`${dim(" Host:")} ${brightCyan(hostName)}`);
  if (isHomeDir) {
    lines.push(
      `${dim(" Repo:")} ${yellow(` Warning: running in home directory`)}`,
    );
  } else {
    lines.push(`${dim(" Repo:")} ${cyan(targetPath)}`);
  }
  if (git.isRepo) {
    lines.push(
      `${dim(" Git Enabled :")} ${green("True")} ${dim("(")} ${magenta(git.branch)}${dim(")")}`,
    );
  } else {
    lines.push(`${dim(" Git Enabled :")} ${dim("False")}`);
  }

  lines.push("");

  // ── Welcome greeting ───────────────────────────────────────────────
  const name = config.display.hostName || "there";
  lines.push(`Hello ${brightCyan(name)}, what are we cracking today?`);
  lines.push("");

  // ── Context bar (shown once) ───────────────────────────────────────
  //    ~/Desktop/apps/crack-code (  main )              gemini-3-flash-preview
  //    -----------------------------------------------------------------------------
  const displayPath = shortenPath(targetPath);
  const leftPart = git.isRepo
    ? `${cyan(displayPath)} ${dim("(")} ${magenta(git.branch)}${dim(")")}`
    : cyan(displayPath);
  const rightPart = modelName ? dim(modelName) : dim("no model");
  const leftLen = stripAnsi(leftPart).length;
  const rightLen = stripAnsi(rightPart).length;
  const gap = Math.max(2, width - leftLen - rightLen);
  lines.push(leftPart + " ".repeat(gap) + rightPart);
  lines.push(dim("-".repeat(width)));

  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// REPL Prompt
// ═════════════════════════════════════════════════════════════════════════════

/** The simple `> ` prompt shown on each REPL iteration */
function getCrackPrompt(): string {
  return `${dim("❯")} `;
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab-Completion for @ mentions and / commands
// ═════════════════════════════════════════════════════════════════════════════

/** Command names + descriptions for / completion hints */
const COMMAND_LIST: Array<[string, string]> = [
  ["/help", "Show all commands"],
  ["/scan", "Run a full security scan"],
  ["/conf", "Edit configuration"],
  ["/tools", "List available tools"],
  ["/mcp", "Manage MCP servers"],
  ["/hud", "Toggle dashboard HUD"],
  ["/icons", "Switch icon mode"],
  ["/report", "View last scan report"],
  ["/status", "Session & provider status"],
  ["/clear", "Clear the screen"],
  ["/exit", "Exit Crack Code"],
  ["/quit", "Exit Crack Code"],
];

/**
 * Build a readline completer function that handles:
 *   - `/` prefix → slash-command completion
 *   - `@` prefix → file/directory completion relative to projectRoot
 */
function buildCompleter(
  projectRoot: string,
): (line: string) => [string[], string] {
  return (line: string): [string[], string] => {
    // Find the current token (last whitespace-delimited word)
    const tokens = line.split(/\s+/);
    const current = tokens[tokens.length - 1] || "";

    // ── / command completion ──────────────────────────────────────
    if (current.startsWith("/")) {
      const matches = COMMAND_LIST.filter(([cmd]) =>
        cmd.startsWith(current.toLowerCase()),
      ).map(([cmd]) => cmd);
      return [
        matches.length > 0 ? matches : COMMAND_LIST.map(([c]) => c),
        current,
      ];
    }

    // ── @ file/directory completion ───────────────────────────────
    if (current.startsWith("@")) {
      const partial = current.slice(1); // strip leading @
      const lastSlash = partial.lastIndexOf("/");
      const dirPart = lastSlash >= 0 ? partial.slice(0, lastSlash + 1) : "";
      const filePart = lastSlash >= 0 ? partial.slice(lastSlash + 1) : partial;

      const searchDir = resolve(projectRoot, dirPart || ".");
      try {
        const entries = readdirSync(searchDir);
        const matches: string[] = [];
        for (const entry of entries) {
          // Skip hidden files and common noise
          if (entry.startsWith(".") || entry === "node_modules") continue;
          if (!entry.toLowerCase().startsWith(filePart.toLowerCase())) continue;

          try {
            const st = statSync(resolve(searchDir, entry));
            const suffix = st.isDirectory() ? "/" : "";
            matches.push("@" + dirPart + entry + suffix);
          } catch {
            matches.push("@" + dirPart + entry);
          }
        }
        return [matches, current];
      } catch {
        return [[], current];
      }
    }

    // No special completion
    return [[], current];
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// CLI Flag Handling
// ═════════════════════════════════════════════════════════════════════════════

function handleCLIFlags(): boolean {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`${APP_NAME} v${APP_VERSION}`);
    return true;
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log("");
    console.log(renderBannerString());
    console.log("");
    console.log(`  ${dim(APP_DESCRIPTION)}`);
    console.log("");
    console.log(`  ${bold("Usage:")}`);
    console.log(
      `    ${cyan("crack-code")}              ${dim("Start the interactive REPL")}`,
    );
    console.log(
      `    ${cyan("crack-code")} ${dim("--version")}    ${dim("Show version")}`,
    );
    console.log(
      `    ${cyan("crack-code")} ${dim("--help")}       ${dim("Show this help")}`,
    );
    console.log("");
    console.log(`  ${bold("Interactive Commands:")}`);
    console.log(`    ${cyan("/help")}     ${dim("Command reference")}`);
    console.log(`    ${cyan("/scan")}     ${dim("Run a full security scan")}`);
    console.log(`    ${cyan("/conf")}     ${dim("Edit configuration")}`);
    console.log(`    ${cyan("/tools")}    ${dim("List available tools")}`);
    console.log(`    ${cyan("/status")}   ${dim("Session & provider status")}`);
    console.log(
      `    ${cyan("/report")}   ${dim("View or export last scan report")}`,
    );
    console.log(`    ${cyan("/hud")}      ${dim("Toggle dashboard HUD")}`);
    console.log(`    ${cyan("/clear")}    ${dim("Clear the screen")}`);
    console.log(`    ${cyan("/exit")}     ${dim("Exit the tool")}`);
    console.log("");
    console.log(`  ${bold("Targeting:")}`);
    console.log(
      `    ${cyan("@src/auth.ts")}           ${dim("Analyze a specific file")}`,
    );
    console.log(
      `    ${cyan("@src/components/")}       ${dim("Analyze a directory")}`,
    );
    console.log("");
    return true;
  }

  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// Application State
// ═════════════════════════════════════════════════════════════════════════════

interface AppState {
  config: CrackCodeConfig;
  provider: BaseProvider | null;
  agent: Agent | null;
  dashboardInfo: DashboardInfo;
  hudEnabled: boolean;
  targetPath: string;
  /** Cached git status — refreshed only on /clear or /conf */
  cachedGit: GitStatus;
  lastScanResult: ScanResult | null;
  lastAnalysisResult: AnalysisResult | null;
  mcpClients: Map<string, MCPClient>;
  mcpCallFn:
    | ((
        serverName: string,
        method: string,
        params: Record<string, unknown>,
      ) => Promise<{ success: boolean; result: unknown; error?: string }>)
    | undefined;
  running: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Main Entry
// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // ── 1. CLI Flags ────────────────────────────────────────────────────
  if (handleCLIFlags()) {
    process.exit(EXIT_CODES.SUCCESS);
  }

  // ── 2. First-Run Wizard ─────────────────────────────────────────────
  let config: CrackCodeConfig;

  // NOTE: setIconMode() is called below after config is loaded (step 3b).
  try {
    config = await ensureWizardCompleted();
  } catch (err) {
    printError(
      `Failed to initialize configuration: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  // ── 3. Create Session ──────────────────────────────────────────────
  const session = createSession();

  // ── 3b. Apply icon mode from config ────────────────────────────
  setIconMode(config.display.iconMode);

  // ── 4. Determine Target Path ────────────────────────────────────────
  const targetArg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const targetPath = resolve(targetArg || process.cwd());

  // ── 5. Register & Bootstrap Provider ───────────────────────────────
  let provider: BaseProvider | null = null;
  let providerError: string | undefined;

  try {
    await withSpinner("Registering providers...", async () => {
      await registerAllBuiltinProviders();
    });

    const apiKey = getEffectiveApiKey(config);
    const baseUrl = getEffectiveBaseUrl(config);

    if (config.provider.id && apiKey) {
      const result = await withSpinner(
        `Connecting to ${getProviderLabel(config)}...`,
        async () => {
          return bootstrapProvider(
            config.provider.id,
            apiKey,
            config.provider.defaultModel,
            baseUrl || undefined,
          );
        },
      );
      provider = result.provider;
      providerError = result.error;

      if (providerError) {
        printWarning(`Provider warning: ${providerError}`);
      }
    } else if (!apiKey && config.provider.id) {
      printWarning(
        `No API key found for ${getProviderLabel(config)}. Use ${cyan("/conf")} to configure.`,
      );
    }
  } catch (err) {
    printWarning(
      `Provider setup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── 6. MCP Setup ──────────────────────────────────────────────────
  const mcpClients = new Map<string, MCPClient>();
  let mcpCallFn: AppState["mcpCallFn"];

  if (config.mcp.enabled && config.mcp.provider) {
    mcpCallFn = createMCPCallFunction(mcpClients);
  }

  // ── 7. Create Agent ────────────────────────────────────────────────
  let agent: Agent | null = null;

  if (provider) {
    try {
      const agentConfig: AgentConfig = {
        provider,
        model: config.provider.defaultModel || provider.getSelectedModel(),
        projectRoot: targetPath,
        mcpEnabled: config.mcp.enabled,
        mcpCall: mcpCallFn,
        streaming: true,
        onStreamDelta: (delta: StreamDelta) => {
          if (delta.text) {
            if (!currentStreamRenderer) {
              currentStreamRenderer = new StreamRenderer();
            }
            currentStreamRenderer.append(delta.text);
          }
        },
        onToolCallStart: (toolName, input) => {
          if (currentStreamRenderer) {
            currentStreamRenderer.end();
            currentStreamRenderer = null;
          }
          process.stdout.write(
            "\n" + formatToolCallCompact(toolName, input) + "\n",
          );
        },
        onToolCallEnd: (toolName, result, durationMs) => {
          process.stdout.write(
            formatToolResultCompact(
              toolName,
              result.success,
              durationMs,
              result.content,
            ) + "\n",
          );
        },
        onThinking: (phase) => {
          if (currentStreamRenderer) {
            currentStreamRenderer.end();
            currentStreamRenderer = null;
          }
          process.stdout.write(
            formatThinkingSpinner(0, phase || "Thinking...") + "\n",
          );
        },
      };
      agent = createAgent(agentConfig);
    } catch (err) {
      printWarning(
        `Agent creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── 8. Build Dashboard Info ────────────────────────────────────────
  let dashboardInfo = createDefaultDashboardInfo(config, targetPath);

  // Update provider health
  if (provider) {
    try {
      const health = await checkProviderHealth(config.provider.id);
      dashboardInfo = updateDashboardProvider(
        dashboardInfo,
        health.healthy,
        health.modelCount ?? 0,
      );
    } catch {
      // Non-fatal — dashboard will show as unhealthy
    }
  }

  // Update MCP status
  if (config.mcp.enabled) {
    dashboardInfo = updateDashboardMCP(dashboardInfo, mcpClients.size > 0);
  }

  // ── 9. Detect Git (cached for the session) ─────────────────────────
  const cachedGit = detectGitStatus(targetPath);

  // ── 10. Resolve model name for display ─────────────────────────────
  const displayModelName =
    config.provider.defaultModel ||
    (provider ? provider.getSelectedModel() : "") ||
    "";

  // ── 11. Build App State ────────────────────────────────────────────
  const state: AppState = {
    config,
    provider,
    agent,
    dashboardInfo,
    hudEnabled: config.display.hudEnabled,
    targetPath,
    cachedGit,
    lastScanResult: null,
    lastAnalysisResult: null,
    mcpClients,
    mcpCallFn,
    running: true,
  };

  // ── 12. Install Exit Handler ───────────────────────────────────────
  session.installExitHandler(() => {
    state.running = false;
    for (const [, client] of state.mcpClients) {
      try {
        client.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    }
    process.exit(EXIT_CODES.SUCCESS);
  });

  // ── 13. Show Dashboard ─────────────────────────────────────────────
  process.stdout.write(
    renderStartupDashboard(config, targetPath, cachedGit, displayModelName),
  );

  // ── 12. Start REPL ─────────────────────────────────────────────────
  await startREPL(state);
}

// ═════════════════════════════════════════════════════════════════════════════
// REPL Loop
// ═════════════════════════════════════════════════════════════════════════════

async function startREPL(state: AppState): Promise<void> {
  const completer = buildCompleter(state.targetPath);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
    completer,
  });

  rl.on("SIGINT", () => {
    process.emit("SIGINT");
  });

  rl.on("close", () => {
    getSession().exit();
  });

  // Show the hint once before the first prompt
  process.stdout.write(
    dim("> Type ") +
      cyan("@") +
      dim(" to mention files, ") +
      cyan("/") +
      dim(" for commands, or ") +
      cyan("/help") +
      dim(" for help") +
      "\n" +
      dim("-".repeat(getTermWidth())) +
      "\n",
  );

  const promptForInput = (): Promise<string> => {
    return new Promise((resolve) => {
      const prefix = getCrackPrompt();
      rl.question(prefix, (answer) => {
        resolve(answer?.trim() ?? "");
      });
    });
  };

  // Main loop
  while (state.running) {
    let input: string;
    try {
      input = await promptForInput();
    } catch {
      break;
    }

    if (!input) continue;

    // ── Handle Slash Commands ──────────────────────────────────────
    if (input.startsWith("/")) {
      const handled = await handleCommand(input, state, rl);
      if (!handled) {
        printWarning(
          `Unknown command: ${cyan(input)}. Type ${cyan("/help")} for available commands.`,
        );
      }
      continue;
    }

    // ── Handle Agent Messages ─────────────────────────────────────
    await handleAgentMessage(input, state);
  }

  rl.close();
}

// ═════════════════════════════════════════════════════════════════════════════
// Command Dispatcher
// ═════════════════════════════════════════════════════════════════════════════

// ── /icons ──────────────────────────────────────────────────────────────────

async function handleIconsCommand(state: AppState): Promise<void> {
  const current = getIconMode();

  const choices: SelectChoice<IconMode>[] = [
    {
      value: "nerd" as IconMode,
      label: `Nerd Font glyphs${current === "nerd" ? dim(" (current)") : ""}`,
    },
    {
      value: "unicode" as IconMode,
      label: `Unicode symbols (✔ ✖ ⚙ →)${current === "unicode" ? dim(" (current)") : ""}`,
    },
    {
      value: "ascii" as IconMode,
      label: `ASCII fallbacks ([ok] [x] [gear] ->)${current === "ascii" ? dim(" (current)") : ""}`,
    },
  ];

  const selected = await selectOption<IconMode>(
    "Select icon rendering mode:",
    choices,
  );

  if (!selected || selected === current) {
    printInfo(`Icon mode unchanged: ${cyan(current)}`);
    return;
  }

  setIconMode(selected);

  // Persist the choice in the config
  state.config = setDisplay(state.config, { iconMode: selected });
  await saveConfig(state.config);

  printSuccess(`Icon mode set to ${cyan(selected)}.`);
  if (selected === "nerd") {
    printInfo(
      `Nerd Font glyphs require a patched terminal font. See ${cyan("/help")} or the README for setup instructions.`,
    );
  }
}

// ── Command Dispatcher ──────────────────────────────────────────────────────
async function handleCommand(
  input: string,
  state: AppState,
  rl: ReadlineInterface,
): Promise<boolean> {
  const normalized = input.toLowerCase().trim();

  switch (normalized) {
    case COMMANDS.HELP:
      process.stdout.write(renderHelpScreen());
      return true;

    case COMMANDS.EXIT:
    case COMMANDS.QUIT:
      getSession().exit();
      return true;

    case COMMANDS.CLEAR: {
      // Refresh git cache on clear
      state.cachedGit = detectGitStatus(state.targetPath);
      const modelName =
        state.config.provider.defaultModel ||
        (state.provider ? state.provider.getSelectedModel() : "") ||
        "";
      process.stdout.write(
        renderStartupDashboard(
          state.config,
          state.targetPath,
          state.cachedGit,
          modelName,
        ),
      );
      return true;
    }

    case COMMANDS.HUD:
      await handleHudToggle(state);
      return true;

    case COMMANDS.STATUS:
      process.stdout.write(renderStatusScreen(state.dashboardInfo));
      return true;

    case COMMANDS.TOOLS:
      await handleToolsCommand(state);
      return true;

    case COMMANDS.CONF:
      await handleConfCommand(state);
      return true;

    case COMMANDS.SCAN:
      await handleScanCommand(state);
      return true;

    case COMMANDS.REPORT:
      await handleReportCommand(state);
      return true;

    case COMMANDS.MCP:
      await handleMCPCommand(state);
      return true;

    case COMMANDS.ICONS:
      await handleIconsCommand(state);
      return true;

    default:
      return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Command Handlers
// ═════════════════════════════════════════════════════════════════════════════

// ── /hud ────────────────────────────────────────────────────────────────────

async function handleHudToggle(state: AppState): Promise<void> {
  state.hudEnabled = !state.hudEnabled;

  // Re-render the dashboard
  state.cachedGit = detectGitStatus(state.targetPath);
  const modelName =
    state.config.provider.defaultModel ||
    (state.provider ? state.provider.getSelectedModel() : "") ||
    "";
  process.stdout.write(
    renderStartupDashboard(
      state.config,
      state.targetPath,
      state.cachedGit,
      modelName,
    ),
  );

  if (state.hudEnabled) {
    printSuccess("Tips are now visible. Type /hud again to hide.");
  } else {
    printInfo("Tips hidden. Type /hud to show them again.");
  }

  // Persist the preference
  state.config.display.hudEnabled = state.hudEnabled;
  try {
    await saveConfig(state.config);
  } catch {
    // Non-fatal
  }
}

// ── /tools ──────────────────────────────────────────────────────────────────

async function handleToolsCommand(state: AppState): Promise<void> {
  const builtinTools = getBuiltinToolSummary();
  // Currently no custom tools — placeholder for future custom tool loading
  const customTools: Array<{ name: string; description: string }> = [];

  process.stdout.write(renderToolsScreen(builtinTools, customTools));
}

// ── /conf ───────────────────────────────────────────────────────────────────

async function handleConfCommand(state: AppState): Promise<void> {
  try {
    const result = await runConfigEditor();

    if (result.config) {
      state.config = result.config;
      state.hudEnabled = state.config.display.hudEnabled;

      // Re-bootstrap provider if it changed
      const apiKey = getEffectiveApiKey(state.config);
      const baseUrl = getEffectiveBaseUrl(state.config);

      if (state.config.provider.id && apiKey) {
        try {
          const bootstrapResult = await withSpinner(
            `Reconnecting to ${getProviderLabel(state.config)}...`,
            async () => {
              return bootstrapProvider(
                state.config.provider.id,
                apiKey,
                state.config.provider.defaultModel,
                baseUrl || undefined,
              );
            },
          );
          state.provider = bootstrapResult.provider;

          if (bootstrapResult.error) {
            printWarning(`Provider warning: ${bootstrapResult.error}`);
          } else {
            printSuccess(`Connected to ${getProviderLabel(state.config)}.`);
          }

          // Rebuild agent with new provider
          rebuildAgent(state);

          // Update dashboard
          const health = await checkProviderHealth(state.config.provider.id);
          state.dashboardInfo = updateDashboardProvider(
            state.dashboardInfo,
            health.healthy,
            health.modelCount ?? 0,
          );
          state.dashboardInfo = {
            ...state.dashboardInfo,
            config: state.config,
          };
        } catch (err) {
          printWarning(
            `Provider reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (state.hudEnabled) {
        state.cachedGit = detectGitStatus(state.targetPath);
        const confModelName =
          state.config.provider.defaultModel ||
          (state.provider ? state.provider.getSelectedModel() : "") ||
          "";
        process.stdout.write(
          renderStartupDashboard(
            state.config,
            state.targetPath,
            state.cachedGit,
            confModelName,
          ),
        );
      }
    }
  } catch (err) {
    printError(
      `Configuration editor error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── /scan ───────────────────────────────────────────────────────────────────

async function handleScanCommand(state: AppState): Promise<void> {
  const session = getSession();
  const scanTarget = state.targetPath;

  printBlank();
  printInfo(
    `${SEARCH_ICON} Starting security scan of ${cyan(basename(scanTarget))}...`,
  );
  printBlank();

  try {
    // Phase 1: Scan the project
    const scanResult = await withSpinner(
      "Scanning project files...",
      async () => {
        return scanProject(scanTarget, {
          onProgress: (scanned, total, currentFile) => {
            // Progress is handled by the spinner
          },
        });
      },
    );

    state.lastScanResult = scanResult;
    session.recordScan();

    printSuccess(
      `Scanned ${scanResult.stats.scannedFiles} files ` +
        `(${scanResult.stats.totalDiscovered} discovered, ` +
        `${scanResult.stats.skippedFiles} skipped)`,
    );

    // Phase 2: Analyze
    const analysisResult = await withSpinner(
      "Analyzing for vulnerabilities...",
      async () => {
        return analyzeProject(scanResult);
      },
    );

    state.lastAnalysisResult = analysisResult;
    session.recordFindings(analysisResult.findings.length);

    // Update dashboard
    state.dashboardInfo = updateDashboardScans(
      state.dashboardInfo,
      session.getScanCount(),
      session.getFindingCount(),
    );

    // Save last scan path
    try {
      const updated = setLastScanPath(state.config, scanTarget);
      await saveConfig(updated);
      state.config = updated;
    } catch {
      // Non-fatal
    }

    // Phase 3: Display results
    const bySeverity = countBySeverity(analysisResult.findings);
    const byCategory = countByCategory(analysisResult.findings);
    const affectedFiles = getAffectedFiles(analysisResult.findings);

    const summaryInput: ScanSummaryInput = {
      totalFiles: scanResult.stats.totalDiscovered,
      scannedFiles: scanResult.stats.scannedFiles,
      skippedFiles: scanResult.stats.skippedFiles,
      totalFindings: analysisResult.findings.length,
      bySeverity,
      byCategory,
      durationMs: scanResult.stats.durationMs + analysisResult.durationMs,
      targetPath: scanTarget,
      affectedFiles,
    };

    process.stdout.write(formatScanSummary(summaryInput));

    if (analysisResult.findings.length > 0) {
      process.stdout.write(
        formatFindingsList(analysisResult.findings, "medium", "severity"),
      );
    } else {
      process.stdout.write(formatNoFindings());
    }

    printBlank();
    printInfo(
      `Use ${cyan("/report")} to export findings as JSON, Markdown, or SARIF.`,
    );

    // If we have warnings from scan or analysis, show them
    const allWarnings = [...scanResult.warnings, ...analysisResult.warnings];
    if (allWarnings.length > 0) {
      printBlank();
      for (const w of allWarnings.slice(0, 5)) {
        printWarning(w);
      }
      if (allWarnings.length > 5) {
        printInfo(dim(`... and ${allWarnings.length - 5} more warnings.`));
      }
    }
  } catch (err) {
    printError(
      `Scan failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── /report ─────────────────────────────────────────────────────────────────

async function handleReportCommand(state: AppState): Promise<void> {
  if (!state.lastAnalysisResult || !state.lastScanResult) {
    printWarning(`No scan results available. Run ${cyan("/scan")} first.`);
    return;
  }

  const findings = state.lastAnalysisResult.findings;
  const scanResult = state.lastScanResult;

  // Ask for format
  const formatChoices: SelectChoice<string>[] = [
    { value: "terminal", label: "Terminal (display here)" },
    { value: "json", label: "JSON file" },
    { value: "markdown", label: "Markdown file" },
    { value: "sarif", label: "SARIF file (IDE-compatible)" },
  ];

  const format = await selectOption("Select report format:", formatChoices);

  if (!format) return;

  if (format === "terminal") {
    // Display full report in terminal
    const bySeverity = countBySeverity(findings);
    const byCategory = countByCategory(findings);
    const affectedFiles = getAffectedFiles(findings);

    const summaryInput: ScanSummaryInput = {
      totalFiles: scanResult.stats.totalDiscovered,
      scannedFiles: scanResult.stats.scannedFiles,
      skippedFiles: scanResult.stats.skippedFiles,
      totalFindings: findings.length,
      bySeverity,
      byCategory,
      durationMs:
        scanResult.stats.durationMs + state.lastAnalysisResult.durationMs,
      targetPath: state.targetPath,
      affectedFiles,
    };

    process.stdout.write(formatFullReport(findings, summaryInput));
    return;
  }

  // Generate file report
  const reportFormat = format as "json" | "markdown" | "sarif";

  const meta: ReportMeta = {
    targetPath: state.targetPath,
    totalFiles: scanResult.stats.totalDiscovered,
    scannedFiles: scanResult.stats.scannedFiles,
    durationMs:
      scanResult.stats.durationMs + state.lastAnalysisResult.durationMs,
    startedAt: scanResult.startedAt,
    completedAt: scanResult.completedAt,
    provider: getProviderLabel(state.config),
    model: state.config.provider.defaultModel,
    sessionId: getSession().sessionId,
  };

  try {
    const outputDir = resolve(state.targetPath, ".crack-code-reports");
    const { filePath, report } = await generateAndWriteReport(
      findings,
      meta,
      reportFormat,
      outputDir,
    );

    printBlank();
    printSuccess(`Report generated: ${cyan(filePath)}`);
    printInfo(
      `${report.findingCount} findings exported as ${reportFormat.toUpperCase()}.`,
    );
  } catch (err) {
    printError(
      `Report generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── /mcp ────────────────────────────────────────────────────────────────────

async function handleMCPCommand(state: AppState): Promise<void> {
  if (!state.config.mcp.enabled) {
    printBlank();
    printInfo("MCP (Model Context Protocol) is currently disabled.");
    printInfo(
      `Use ${cyan("/conf")} to enable MCP and configure web search providers.`,
    );
    printBlank();
    return;
  }

  printBlank();
  printInfo(`${GEAR_ICON} MCP Configuration`);
  printBlank();
  printInfo(`Provider: ${bold(state.config.mcp.provider ?? dim("none"))}`);
  printInfo(
    `API Key:  ${state.config.mcp.apiKey ? green("configured") : yellow("not set")}`,
  );
  printInfo(
    `Servers:  ${state.config.mcp.enabledServers.length > 0 ? state.config.mcp.enabledServers.join(", ") : dim("none")}`,
  );
  printInfo(
    `Status:   ${state.mcpClients.size > 0 ? green("connected") : yellow("disconnected")}`,
  );
  printBlank();
  printInfo(`Use ${cyan("/conf")} to modify MCP settings.`);
  printBlank();
}

// ═════════════════════════════════════════════════════════════════════════════
// Agent Message Handling
// ═════════════════════════════════════════════════════════════════════════════

async function handleAgentMessage(
  input: string,
  state: AppState,
): Promise<void> {
  if (!state.agent) {
    if (!state.provider) {
      printBlank();
      printError(
        `No AI provider configured. Use ${cyan("/conf")} to set up a provider and API key.`,
      );
      printBlank();
      return;
    }

    // Try to rebuild the agent
    rebuildAgent(state);

    if (!state.agent) {
      printError(
        "Failed to create the AI agent. Check your provider configuration.",
      );
      return;
    }
  }

  // Parse @ mentions for file targeting
  const { message, targets } = parseTargetMentions(input);

  let fileContext: string | undefined;

  if (targets.length > 0) {
    try {
      fileContext = await withSpinner(
        `Reading ${targets.length} target${targets.length > 1 ? "s" : ""}...`,
        async () => {
          return buildTargetContext(targets, state.targetPath);
        },
      );
    } catch (err) {
      printWarning(
        `Failed to read targets: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const effectiveMessage = message || input;

  // Track timing for the progress indicator
  const startTime = Date.now();

  try {
    printBlank();

    const response = await state.agent.processMessage(
      effectiveMessage,
      fileContext,
    );

    if (currentStreamRenderer) {
      currentStreamRenderer.end();
      currentStreamRenderer = null;
    }

    // If streaming was used, the text was already written via onStreamDelta.
    // For non-streaming or if we need to display the final formatted response:
    if (!response.ok) {
      process.stdout.write(
        formatAgentError(response.error ?? "Unknown error") + "\n",
      );
    } else if (response.text && !state.agent) {
      // Fallback for non-streaming mode
      process.stdout.write(formatAgentResponse(response.text) + "\n");
    }

    // ── Completion indicator (ui.md Fig. 3: ◎ Done · duration) ────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(
      "\r\x1b[K\n" +
        formatProgressIndicator("Done", `${elapsed}s`, false) +
        "\n",
    );

    printBlank();
  } catch (err) {
    // ── Error completion indicator ────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(
      "\r\x1b[K\n" +
        formatProgressIndicator("Failed", `${elapsed}s`, false) +
        "\n",
    );
    printBlank();
    printError(
      `Agent error: ${err instanceof Error ? err.message : String(err)}`,
    );
    printBlank();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Agent Rebuilding
// ═════════════════════════════════════════════════════════════════════════════

function rebuildAgent(state: AppState): void {
  if (!state.provider) return;

  try {
    const agentConfig: AgentConfig = {
      provider: state.provider,
      model:
        state.config.provider.defaultModel || state.provider.getSelectedModel(),
      projectRoot: state.targetPath,
      mcpEnabled: state.config.mcp.enabled,
      mcpCall: state.mcpCallFn,
      streaming: true,
      onStreamDelta: (delta: StreamDelta) => {
        if (delta.text) {
          if (!currentStreamRenderer) {
            process.stdout.write("\r\x1b[K");
            currentStreamRenderer = new StreamRenderer({
              prefix: "  ",
              firstLinePrefix: `${cyan("◐")} `,
            });
          }
          currentStreamRenderer.append(delta.text);
        }
      },
      onToolCallStart: (toolName, input) => {
        if (currentStreamRenderer) {
          currentStreamRenderer.end();
          currentStreamRenderer = null;
        } else {
          process.stdout.write("\r\x1b[K");
        }
        process.stdout.write(formatToolCallCompact(toolName, input) + "\n");
      },
      onToolCallEnd: (toolName, result, durationMs) => {
        process.stdout.write(
          formatToolResultCompact(
            toolName,
            result.success,
            durationMs,
            result.content,
          ) + "\n",
        );
      },
      onThinking: (phase) => {
        if (currentStreamRenderer) {
          currentStreamRenderer.end();
          currentStreamRenderer = null;
        }
        process.stdout.write(
          formatThinkingSpinner(0, phase || "Thinking...") + "\x1b[K",
        );
      },
    };
    state.agent = createAgent(agentConfig);
  } catch (err) {
    printWarning(
      `Agent rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    state.agent = null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Entry Point
// ═════════════════════════════════════════════════════════════════════════════

main().catch((err) => {
  console.error(
    `\n  ${red(CROSS_MARK)} ${bold(red("Fatal error:"))} ${err instanceof Error ? err.message : String(err)}\n`,
  );
  if (err instanceof Error && err.stack) {
    console.error(dim(err.stack));
  }
  process.exit(EXIT_CODES.GENERAL_ERROR);
});
