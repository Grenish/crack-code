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
  SHIELD_ICON,
  CHECK_MARK,
  CROSS_MARK,
  WARNING_MARK,
  GEAR_ICON,
  SEARCH_ICON,
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
  formatToolCallStart,
  formatToolCallResult,
  formatThinkingIndicator,
  formatNoFindings,
  type ScanSummaryInput,
} from "./output/formatter.js";

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

  // Gradient colors across banner lines
  const colors = [brightCyan, cyan, brightGreen, green, brightCyan, cyan];

  for (let i = 0; i < CRACK_CODE_BANNER.length; i++) {
    const colorFn = colors[i % colors.length]!;
    lines.push(colorFn(CRACK_CODE_BANNER[i]!));
  }

  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// Startup Dashboard (matches ui.md "After Config" spec)
// ═════════════════════════════════════════════════════════════════════════════

function renderStartupDashboard(
  config: CrackCodeConfig,
  targetPath: string,
  git: GitStatus,
  hudEnabled: boolean,
): string {
  const lines: string[] = [];

  // Clear screen
  lines.push("\x1B[2J\x1B[H");
  lines.push("");

  // ASCII art banner
  lines.push(renderBannerString());
  lines.push("");

  // ── Meta info ──────────────────────────────────────────────────────
  const hostName = config.display.hostName || "User";

  // Version
  lines.push(` ${dim("version:")} ${white(APP_VERSION)}`);

  // Host
  lines.push(` ${dim("Host:")} ${brightCyan(hostName)}`);

  // Repo — warn if running from home directory
  const homeDir = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  const isHomeDir = targetPath === homeDir || targetPath === homeDir + "/";
  if (isHomeDir) {
    lines.push(
      ` ${dim("Repo:")} ${yellow(`${WARNING_MARK} Warning: running in home directory`)}`,
    );
  } else {
    lines.push(` ${dim("Repo:")} ${cyan(targetPath)}`);
  }

  // Git
  if (git.isRepo) {
    lines.push(
      ` ${dim("Git Enabled:")} ${green("True")} ${dim("(")} ${magenta(git.branch)} ${dim(")")}`,
    );
  } else {
    lines.push(` ${dim("Git Enabled:")} ${dim("False")}`);
  }

  // ── Tips (only when HUD is enabled) ────────────────────────────────
  if (hudEnabled) {
    lines.push("");
    lines.push(` ${bold("Tips for getting started:")}`);
    lines.push(
      ` ${dim("1.")} type ${cyan("/help")} to list out the available commands.`,
    );
    lines.push(
      ` ${dim("2.")} type ${cyan("/conf")} to configure the AI model and API Keys.`,
    );
    lines.push(` ${dim("3.")} type ${cyan("@")} to select the file or folder.`);
    lines.push(
      ` ${dim("4.")} type ${cyan("/tools")} to list out the available tools.`,
    );
    lines.push(
      ` ${dim("5.")} type ${cyan("/mcp")} to configure the mcp server.`,
    );
    lines.push(
      ` ${dim("6.")} type ${cyan("/hud")} to hide/show this tips from next time.`,
    );
  }

  // Tagline
  lines.push(` ${brightGreen("Happy Crack Code")} ${SHIELD_ICON}`);
  lines.push("");

  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// Welcome Greeting (matches ui.md spec)
// ═════════════════════════════════════════════════════════════════════════════

function renderWelcomeGreeting(config: CrackCodeConfig): string {
  const name = config.display.hostName || "there";
  const lines: string[] = [];

  lines.push(
    ` ${bold("Hello")} ${bold(brightCyan(name))}${bold(", what are we cracking today?")}`,
  );
  lines.push("");

  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// REPL Prompt (matches ui.md spec)
// ═════════════════════════════════════════════════════════════════════════════

function getCrackPrompt(): string {
  return `${SHIELD_ICON} ${dim(">")} `;
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
            process.stdout.write(delta.text);
          }
        },
        onToolCallStart: (toolName, input) => {
          process.stdout.write(formatToolCallStart(toolName, input) + "\n");
        },
        onToolCallEnd: (toolName, result, durationMs) => {
          process.stdout.write(
            formatToolCallResult(
              toolName,
              result.success,
              durationMs,
              result.content.slice(0, 120),
            ) + "\n",
          );
        },
        onThinking: (phase) => {
          process.stdout.write(formatThinkingIndicator(phase) + "\n");
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

  // ── 9. Build App State ─────────────────────────────────────────────
  const state: AppState = {
    config,
    provider,
    agent,
    dashboardInfo,
    hudEnabled: config.display.hudEnabled,
    targetPath,
    lastScanResult: null,
    lastAnalysisResult: null,
    mcpClients,
    mcpCallFn,
    running: true,
  };

  // ── 10. Install Exit Handler ───────────────────────────────────────
  session.installExitHandler(() => {
    state.running = false;
    // Cleanup MCP clients
    for (const [, client] of state.mcpClients) {
      try {
        client.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    }
    process.exit(EXIT_CODES.SUCCESS);
  });

  // ── 11. Show Dashboard & Welcome ───────────────────────────────────
  const git = detectGitStatus(targetPath);
  process.stdout.write(
    renderStartupDashboard(config, targetPath, git, state.hudEnabled),
  );
  process.stdout.write(renderWelcomeGreeting(config));

  // ── 12. Start REPL ─────────────────────────────────────────────────
  await startREPL(state);
}

// ═════════════════════════════════════════════════════════════════════════════
// REPL Loop
// ═════════════════════════════════════════════════════════════════════════════

async function startREPL(state: AppState): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });

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
      // stdin closed or readline error — exit gracefully
      break;
    }

    // Skip empty input
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
      const gitInfo = detectGitStatus(state.targetPath);
      process.stdout.write(
        renderStartupDashboard(
          state.config,
          state.targetPath,
          gitInfo,
          state.hudEnabled,
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

  // Re-render the dashboard with tips shown/hidden
  const git = detectGitStatus(state.targetPath);
  process.stdout.write(
    renderStartupDashboard(
      state.config,
      state.targetPath,
      git,
      state.hudEnabled,
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
        const gitRefresh = detectGitStatus(state.targetPath);
        process.stdout.write(
          renderStartupDashboard(
            state.config,
            state.targetPath,
            gitRefresh,
            state.hudEnabled,
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

  try {
    printBlank();

    const response = await state.agent.processMessage(
      effectiveMessage,
      fileContext,
    );

    // If streaming was used, the text was already written via onStreamDelta.
    // For non-streaming or if we need to display the final formatted response:
    if (!response.ok) {
      process.stdout.write(
        formatAgentError(response.error ?? "Unknown error") + "\n",
      );
    } else if (response.text && !state.agent) {
      // Fallback for non-streaming mode
      process.stdout.write(formatAgentResponse(response.text) + "\n");
    } else if (response.text) {
      // After streaming, add a newline for clean separation
      process.stdout.write("\n");
    }

    printBlank();
  } catch (err) {
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
          process.stdout.write(delta.text);
        }
      },
      onToolCallStart: (toolName, input) => {
        process.stdout.write(formatToolCallStart(toolName, input) + "\n");
      },
      onToolCallEnd: (toolName, result, durationMs) => {
        process.stdout.write(
          formatToolCallResult(
            toolName,
            result.success,
            durationMs,
            result.content.slice(0, 120),
          ) + "\n",
        );
      },
      onThinking: (phase) => {
        process.stdout.write(formatThinkingIndicator(phase) + "\n");
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
