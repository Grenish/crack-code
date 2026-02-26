// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — TUI Dashboard
// ─────────────────────────────────────────────────────────────────────────────
// Renders the terminal dashboard with ASCII branding, version info, host
// greeting, repository path + Git status, tips, and the prompt input box.
// The dashboard is the persistent "HUD" shown above the REPL prompt.
//
// Zero external dependencies — uses only built-in Node APIs and the
// project's own color/logger utilities.
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from "node:child_process";
import { basename, resolve } from "node:path";
import {
  bold,
  dim,
  cyan,
  green,
  yellow,
  red,
  white,
  gray,
  brightCyan,
  brightGreen,
  brightYellow,
  brightMagenta,
  magenta,
  blue,
  brightBlue,
  italic,
  underline,
  box,
  separator,
  kvPair,
  sectionHeader,
  stripAnsi,
  SHIELD_ICON,
  BUG_ICON,
  LOCK_ICON,
  SEARCH_ICON,
  GEAR_ICON,
  ROCKET_ICON,
  FOLDER_ICON,
  CHECK_MARK,
  CROSS_MARK,
  WARNING_MARK,
  ARROW_RIGHT,
  BULLET_POINT,
  INFO_MARK,
} from "../utils/colors.js";

import {
  APP_NAME,
  APP_BIN,
  APP_VERSION,
  APP_DESCRIPTION,
  COMMANDS,
  AI_PROVIDER,
  AI_PROVIDER_LABELS,
  type AIProvider,
} from "../utils/constants.js";

import type { CrackCodeConfig } from "../config/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** Git repository status information */
export interface GitStatus {
  /** Whether the current directory is inside a Git repository */
  isRepo: boolean;
  /** Current branch name */
  branch: string;
  /** Short commit hash */
  commitHash: string;
  /** Whether the working tree is clean */
  isClean: boolean;
  /** Number of uncommitted changes */
  changedFiles: number;
  /** Number of untracked files */
  untrackedFiles: number;
  /** Remote URL (origin) */
  remoteUrl: string;
  /** Repo root path */
  repoRoot: string;
}

/** Information displayed in the dashboard */
export interface DashboardInfo {
  /** The user's config */
  config: CrackCodeConfig;
  /** Current working directory / scan target */
  targetPath: string;
  /** Git status of the target */
  git: GitStatus;
  /** Whether the provider is connected and healthy */
  providerHealthy: boolean;
  /** Number of available models */
  modelCount: number;
  /** Current session scan count */
  scanCount: number;
  /** Current session finding count */
  findingCount: number;
  /** Whether MCP is connected */
  mcpConnected: boolean;
}

// ── ASCII Art Banner ────────────────────────────────────────────────────────

const BANNER_LINES = [
  "  ██████╗██████╗  █████╗  ██████╗██╗  ██╗     ██████╗ ██████╗ ██████╗ ███████╗",
  " ██╔════╝██╔══██╗██╔══██╗██╔════╝██║ ██╔╝    ██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  " ██║     ██████╔╝███████║██║     █████╔╝     ██║     ██║   ██║██║  ██║█████╗  ",
  " ██║     ██╔══██╗██╔══██║██║     ██╔═██╗     ██║     ██║   ██║██║  ██║██╔══╝  ",
  " ╚██████╗██║  ██║██║  ██║╚██████╗██║  ██╗    ╚██████╗╚██████╔╝██████╔╝███████╗",
  "  ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
];

const BANNER_COMPACT_LINES = [
  " ╔═╗╦═╗╔═╗╔═╗╦╔═  ╔═╗╔═╗╔╦╗╔═╗",
  " ║  ╠╦╝╠═╣║  ╠╩╗  ║  ║ ║ ║║║╣ ",
  " ╚═╝╩╚═╩ ╩╚═╝╩ ╩  ╚═╝╚═╝═╩╝╚═╝",
];

// ── Git Helpers ─────────────────────────────────────────────────────────────

/**
 * Detect Git repository status for a given path.
 * All Git commands are best-effort; failures produce a "not a repo" result.
 */
export function detectGitStatus(targetPath: string): GitStatus {
  const empty: GitStatus = {
    isRepo: false,
    branch: "",
    commitHash: "",
    isClean: true,
    changedFiles: 0,
    untrackedFiles: 0,
    remoteUrl: "",
    repoRoot: "",
  };

  try {
    const cwd = resolve(targetPath);

    // Check if inside a Git repo
    const repoRoot = safeExec("git rev-parse --show-toplevel", cwd);
    if (!repoRoot) return empty;

    // Branch name
    const branch = safeExec("git rev-parse --abbrev-ref HEAD", cwd) || "HEAD";

    // Short commit hash
    const commitHash = safeExec("git rev-parse --short HEAD", cwd) || "";

    // Status — porcelain for easy parsing
    const statusOutput = safeExec("git status --porcelain", cwd) || "";
    const statusLines = statusOutput
      .split("\n")
      .filter((l) => l.trim().length > 0);

    const changedFiles = statusLines.filter((l) => !l.startsWith("??")).length;
    const untrackedFiles = statusLines.filter((l) => l.startsWith("??")).length;
    const isClean = statusLines.length === 0;

    // Remote URL
    const remoteUrl = safeExec("git config --get remote.origin.url", cwd) || "";

    return {
      isRepo: true,
      branch,
      commitHash,
      isClean,
      changedFiles,
      untrackedFiles,
      remoteUrl,
      repoRoot: repoRoot.trim(),
    };
  } catch {
    return empty;
  }
}

/**
 * Execute a shell command synchronously and return trimmed stdout.
 * Returns empty string on failure.
 */
function safeExec(command: string, cwd: string): string {
  try {
    return execSync(command, {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

// ── Dashboard Rendering ─────────────────────────────────────────────────────

/**
 * Get the terminal width, clamped to a sane range.
 */
function getTerminalWidth(): number {
  const cols = (process.stdout as NodeJS.WriteStream).columns || 80;
  return Math.max(60, Math.min(cols, 120));
}

/**
 * Center a string within the given width.
 */
function center(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const leftPad = Math.floor((width - visible) / 2);
  return " ".repeat(leftPad) + text;
}

/**
 * Right-pad a string to the given width (accounting for ANSI codes).
 */
function pad(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  return text + " ".repeat(width - visible);
}

/**
 * Create a horizontal rule.
 */
function hr(width: number, char: string = "─"): string {
  return dim(char.repeat(width));
}

/**
 * Render the full-size ASCII art banner with gradient coloring.
 */
function renderBanner(width: number): string[] {
  const lines: string[] = [];
  const useCompact = width < 85;
  const bannerSource = useCompact ? BANNER_COMPACT_LINES : BANNER_LINES;

  // Apply a cyan→green gradient across lines
  const colors = [brightCyan, cyan, brightGreen, green, brightCyan, cyan];

  for (let i = 0; i < bannerSource.length; i++) {
    const colorFn = colors[i % colors.length]!;
    const line = bannerSource[i]!;
    lines.push(center(colorFn(line), width));
  }

  return lines;
}

/**
 * Render the tagline and version.
 */
function renderTagline(width: number): string[] {
  const lines: string[] = [];

  const tagline = `${SHIELD_ICON} ${bold(APP_NAME)} ${dim("v" + APP_VERSION)} ${dim("—")} ${dim(APP_DESCRIPTION)}`;
  lines.push(center(tagline, width));

  return lines;
}

/**
 * Render the host greeting and provider status.
 */
function renderHostSection(info: DashboardInfo, width: number): string[] {
  const lines: string[] = [];
  const { config } = info;

  // Greeting
  const greeting = `${ROCKET_ICON} Welcome, ${bold(brightCyan(config.display.hostName))}!`;
  lines.push(`  ${greeting}`);

  lines.push(`  ${hr(width - 4)}`);

  // Provider status
  const providerLabel =
    AI_PROVIDER_LABELS[config.provider.id] ?? config.provider.id;
  const providerStatus = info.providerHealthy
    ? green(`${CHECK_MARK} Connected`)
    : red(`${CROSS_MARK} Disconnected`);
  lines.push(
    `  ${dim("Provider:")}  ${bold(white(providerLabel))} ${dim("│")} ${providerStatus}`,
  );

  // Model
  const modelDisplay = config.provider.defaultModel || dim("(none selected)");
  lines.push(
    `  ${dim("Model:")}     ${white(modelDisplay)} ${dim("│")} ${dim(`${info.modelCount} available`)}`,
  );

  // MCP status
  if (config.mcp.enabled) {
    const mcpStatus = info.mcpConnected
      ? green(`${CHECK_MARK} Active`)
      : yellow(`${WARNING_MARK} Configured`);
    const mcpProvider = config.mcp.provider ?? "context7";
    lines.push(
      `  ${dim("MCP:")}       ${white(mcpProvider)} ${dim("│")} ${mcpStatus}`,
    );
  }

  return lines;
}

/**
 * Render the repository / target path section.
 */
function renderRepoSection(info: DashboardInfo, width: number): string[] {
  const lines: string[] = [];
  const { git, targetPath } = info;

  lines.push(`  ${hr(width - 4)}`);

  // Target path
  const displayPath = targetPath.startsWith(process.env["HOME"] || "~")
    ? targetPath.replace(process.env["HOME"] || "~", "~")
    : targetPath;
  lines.push(`  ${FOLDER_ICON} ${dim("Target:")}  ${bold(cyan(displayPath))}`);

  // Git info
  if (git.isRepo) {
    const branchDisplay = brightMagenta(git.branch);
    const commitDisplay = git.commitHash ? dim(`@ ${git.commitHash}`) : "";

    let statusBadge: string;
    if (git.isClean) {
      statusBadge = green(`${CHECK_MARK} clean`);
    } else {
      const parts: string[] = [];
      if (git.changedFiles > 0) {
        parts.push(yellow(`${git.changedFiles} modified`));
      }
      if (git.untrackedFiles > 0) {
        parts.push(dim(`${git.untrackedFiles} untracked`));
      }
      statusBadge = parts.join(dim(" │ "));
    }

    lines.push(
      `  ${dim("⎇ Branch:")}  ${branchDisplay} ${commitDisplay} ${dim("│")} ${statusBadge}`,
    );

    // Remote URL (show shortened version)
    if (git.remoteUrl) {
      const shortRemote = shortenRemoteUrl(git.remoteUrl);
      lines.push(`  ${dim("  Remote:")}  ${dim(shortRemote)}`);
    }
  } else {
    lines.push(
      `  ${dim("⎇ Git:")}     ${yellow(`${WARNING_MARK} Not a Git repository`)}`,
    );
  }

  return lines;
}

/**
 * Shorten a Git remote URL for display.
 */
function shortenRemoteUrl(url: string): string {
  // SSH: git@github.com:user/repo.git → user/repo
  const sshMatch = url.match(/@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1] ?? url;

  // HTTPS: https://github.com/user/repo.git → user/repo
  const httpsMatch = url.match(/https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1] ?? url;

  return url;
}

/**
 * Render the session statistics section.
 */
function renderStatsSection(info: DashboardInfo, width: number): string[] {
  const lines: string[] = [];

  lines.push(`  ${hr(width - 4)}`);

  const scanLabel = info.scanCount === 1 ? "scan" : "scans";
  const findingLabel = info.findingCount === 1 ? "finding" : "findings";

  lines.push(
    `  ${SEARCH_ICON} ${dim("Session:")}  ${white(String(info.scanCount))} ${dim(scanLabel)} ${dim("│")} ` +
      `${BUG_ICON} ${white(String(info.findingCount))} ${dim(findingLabel)}`,
  );

  return lines;
}

/**
 * Render the tips / quick-help section.
 */
function renderTips(width: number): string[] {
  const lines: string[] = [];

  lines.push(`  ${hr(width - 4)}`);
  lines.push(`  ${dim(GEAR_ICON + " Quick Commands:")}`);

  const tips = [
    [COMMANDS.HELP, "Show all commands"],
    [COMMANDS.SCAN, "Scan the current project"],
    [COMMANDS.CONF, "Edit configuration"],
    [COMMANDS.TOOLS, "List available tools"],
    [COMMANDS.MCP, "Manage MCP servers"],
    [COMMANDS.HUD, "Toggle this dashboard"],
    [COMMANDS.REPORT, "View last scan report"],
  ];

  // Render in two columns if space allows
  const colWidth = Math.floor((width - 8) / 2);

  for (let i = 0; i < tips.length; i += 2) {
    const left = tips[i]!;
    const right = tips[i + 1];

    let line = `    ${cyan(left[0]!)}  ${dim(left[1]!)}`;
    if (right && colWidth > 30) {
      const leftVisible = stripAnsi(line).length;
      const padding = Math.max(2, colWidth - leftVisible + 4);
      line += " ".repeat(padding) + `${cyan(right[0]!)}  ${dim(right[1]!)}`;
    }

    lines.push(line);

    // If not doing columns, render right as its own line
    if (right && colWidth <= 30) {
      lines.push(`    ${cyan(right[0]!)}  ${dim(right[1]!)}`);
    }
  }

  lines.push("");
  lines.push(
    center(
      dim(
        `Type a message to start analyzing, or use ${cyan("@path")} to target specific files.`,
      ),
      width,
    ),
  );

  return lines;
}

/**
 * Render the prompt box / input area indicator.
 */
function renderPromptBox(config: CrackCodeConfig, width: number): string[] {
  const lines: string[] = [];

  const aiName = config.display.aiName || APP_NAME;
  const promptPrefix = `${brightCyan(SHIELD_ICON)} ${bold(cyan(aiName))} ${dim(ARROW_RIGHT)} `;

  lines.push(`  ${hr(width - 4, "═")}`);
  lines.push(`  ${promptPrefix}`);

  return lines;
}

/**
 * Render a warning box (e.g., for missing config).
 */
function renderWarningBox(message: string, width: number): string[] {
  const lines: string[] = [];
  const innerWidth = Math.min(width - 6, 70);
  const border = yellow("─".repeat(innerWidth));

  lines.push(`  ${yellow("┌")}${border}${yellow("┐")}`);

  // Word-wrap the message
  const words = message.split(" ");
  let currentLine = "";
  for (const word of words) {
    if (stripAnsi(currentLine + " " + word).length > innerWidth - 4) {
      const padded = pad(
        `  ${yellow(WARNING_MARK)} ${currentLine}`,
        innerWidth + 2,
      );
      lines.push(`  ${yellow("│")}${padded}${yellow("│")}`);
      currentLine = word;
    } else {
      currentLine = currentLine ? `${currentLine} ${word}` : word;
    }
  }
  if (currentLine) {
    const padded = pad(
      `  ${yellow(WARNING_MARK)} ${currentLine}`,
      innerWidth + 2,
    );
    lines.push(`  ${yellow("│")}${padded}${yellow("│")}`);
  }

  lines.push(`  ${yellow("└")}${border}${yellow("┘")}`);

  return lines;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Render the full dashboard to a string.
 * This is the main entry point — call it whenever the HUD needs to refresh.
 *
 * @param info - Dashboard display information.
 * @returns A multi-line string ready to be written to stdout.
 */
export function renderDashboard(info: DashboardInfo): string {
  const width = getTerminalWidth();
  const output: string[] = [];

  // Clear screen
  output.push("\x1B[2J\x1B[H"); // clear + home

  // Top margin
  output.push("");

  // Banner
  output.push(...renderBanner(width));
  output.push("");

  // Tagline
  output.push(...renderTagline(width));
  output.push("");

  // Host & provider section
  output.push(...renderHostSection(info, width));

  // Repo section
  output.push(...renderRepoSection(info, width));

  // Stats section (only if there are scans)
  if (info.scanCount > 0 || info.findingCount > 0) {
    output.push(...renderStatsSection(info, width));
  }

  // Warnings
  const warnings = collectWarnings(info);
  if (warnings.length > 0) {
    output.push("");
    for (const warning of warnings) {
      output.push(...renderWarningBox(warning, width));
    }
  }

  // Tips
  output.push(...renderTips(width));
  output.push("");

  return output.join("\n");
}

/**
 * Render a compact / minimal dashboard (for when HUD is toggled on after
 * being off, or for narrow terminals).
 */
export function renderCompactDashboard(info: DashboardInfo): string {
  const width = getTerminalWidth();
  const output: string[] = [];
  const { config, git, targetPath } = info;

  const providerLabel =
    AI_PROVIDER_LABELS[config.provider.id] ?? config.provider.id;
  const modelDisplay = config.provider.defaultModel || "?";
  const status = info.providerHealthy ? green(CHECK_MARK) : red(CROSS_MARK);

  const displayPath = targetPath.startsWith(process.env["HOME"] || "~")
    ? targetPath.replace(process.env["HOME"] || "~", "~")
    : targetPath;

  // Single-line compact header
  output.push(
    `  ${brightCyan(SHIELD_ICON)} ${bold(cyan(APP_NAME))} ${dim("v" + APP_VERSION)} ${dim("│")} ` +
      `${status} ${dim(providerLabel)} ${dim("/")} ${white(modelDisplay)} ${dim("│")} ` +
      `${FOLDER_ICON} ${cyan(basename(displayPath))}` +
      (git.isRepo ? ` ${dim("⎇")} ${brightMagenta(git.branch)}` : ""),
  );

  output.push(`  ${hr(width - 4)}`);

  return output.join("\n");
}

/**
 * Render just the prompt prefix string (used by the REPL).
 * Does NOT include the full dashboard — just the input prompt indicator.
 */
export function getPromptPrefix(config: CrackCodeConfig): string {
  const aiName = config.display.aiName || APP_NAME;
  return `${brightCyan(SHIELD_ICON)} ${bold(cyan(aiName))} ${dim(ARROW_RIGHT)} `;
}

/**
 * Render the welcome message shown immediately after the dashboard
 * on first launch.
 */
export function renderWelcomeMessage(config: CrackCodeConfig): string {
  const lines: string[] = [];
  const aiName = config.display.aiName || APP_NAME;

  lines.push("");
  lines.push(
    `  ${green(CHECK_MARK)} ${bold("Ready!")} ${aiName} is online and ready to analyze your code.`,
  );
  lines.push(
    `  ${dim(
      `Type a security question, describe a concern, or use ${cyan("/scan")} to start a full analysis.`,
    )}`,
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Render the help screen shown when the user types /help.
 */
export function renderHelpScreen(): string {
  const width = getTerminalWidth();
  const lines: string[] = [];

  lines.push("");
  lines.push(
    `  ${sectionHeader(`${SHIELD_ICON} ${APP_NAME} — Command Reference`)}`,
  );
  lines.push("");

  const commands: Array<[string, string, string]> = [
    [COMMANDS.HELP, "Show this help screen", ""],
    [COMMANDS.SCAN, "Run a full security scan", "Analyzes the entire project"],
    [COMMANDS.CONF, "Edit configuration", "Provider, model, API keys, display"],
    [COMMANDS.TOOLS, "List available tools", "Built-in and custom tools"],
    [COMMANDS.MCP, "Manage MCP servers", "Add, remove, configure MCP"],
    [COMMANDS.HUD, "Toggle the dashboard HUD", "Show/hide the top panel"],
    [
      COMMANDS.ICONS,
      "Switch icon rendering mode",
      "Nerd Font, Unicode, or ASCII",
    ],
    [COMMANDS.REPORT, "View last scan report", "Findings summary & details"],
    [COMMANDS.STATUS, "Show session status", "Provider health, scan stats"],
    [COMMANDS.CLEAR, "Clear the screen", ""],
    [`${COMMANDS.EXIT} / ${COMMANDS.QUIT}`, "Exit Crack Code", ""],
  ];

  for (const [cmd, desc, detail] of commands) {
    lines.push(`  ${cyan(cmd)}`);
    lines.push(`      ${white(desc)}${detail ? dim(` — ${detail}`) : ""}`);
  }

  lines.push("");
  lines.push(`  ${sectionHeader("Targeting")}`);
  lines.push("");
  lines.push(
    `  ${cyan("@path/to/file.ts")}   ${dim("Target a specific file for analysis")}`,
  );
  lines.push(
    `  ${cyan("@src/components/")}   ${dim("Target a directory for analysis")}`,
  );
  lines.push(
    `  ${cyan("@*.config.ts")}       ${dim("Target files matching a pattern")}`,
  );
  lines.push("");
  lines.push(`  ${sectionHeader("Usage Tips")}`);
  lines.push("");
  lines.push(
    `  ${dim(BULLET_POINT)} ${white("Ask natural language questions")} ${dim("about your code's security.")}`,
  );
  lines.push(
    `  ${dim(BULLET_POINT)} ${white("Use @mentions")} ${dim("to focus analysis on specific files/folders.")}`,
  );
  lines.push(
    `  ${dim(BULLET_POINT)} ${white("Findings include severity")}${dim(", category, remediation & AI prompts.")}`,
  );
  lines.push(
    `  ${dim(BULLET_POINT)} ${white("The tool never modifies")} ${dim("your source files. Read-only analysis only.")}`,
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Render the status screen shown when the user types /status.
 */
export function renderStatusScreen(info: DashboardInfo): string {
  const width = getTerminalWidth();
  const lines: string[] = [];
  const { config, git } = info;

  lines.push("");
  lines.push(`  ${sectionHeader(`${SHIELD_ICON} Session Status`)}`);
  lines.push("");

  // Provider
  const providerLabel =
    AI_PROVIDER_LABELS[config.provider.id] ?? config.provider.id;
  const providerStatus = info.providerHealthy
    ? green(`${CHECK_MARK} Healthy`)
    : red(`${CROSS_MARK} Unhealthy`);
  lines.push(
    `  ${dim("Provider:")}     ${bold(providerLabel)} ${dim("—")} ${providerStatus}`,
  );
  lines.push(
    `  ${dim("Model:")}        ${config.provider.defaultModel || dim("(not set)")}`,
  );
  lines.push(`  ${dim("Models avail:")} ${String(info.modelCount)}`);
  lines.push("");

  // MCP
  if (config.mcp.enabled) {
    const mcpStatus = info.mcpConnected
      ? green(`${CHECK_MARK} Connected`)
      : yellow(`${WARNING_MARK} Not connected`);
    lines.push(
      `  ${dim("MCP:")}          ${config.mcp.provider ?? dim("none")} ${dim("—")} ${mcpStatus}`,
    );
    lines.push(
      `  ${dim("MCP servers:")}  ${config.mcp.enabledServers.join(", ") || dim("none")}`,
    );
  } else {
    lines.push(`  ${dim("MCP:")}          ${dim("disabled")}`);
  }
  lines.push("");

  // Git
  if (git.isRepo) {
    lines.push(
      `  ${dim("Git branch:")}   ${brightMagenta(git.branch)} ${dim("@")} ${dim(git.commitHash)}`,
    );
    lines.push(
      `  ${dim("Working tree:")} ${
        git.isClean
          ? green("clean")
          : yellow(
              `${git.changedFiles} modified, ${git.untrackedFiles} untracked`,
            )
      }`,
    );
    if (git.remoteUrl) {
      lines.push(
        `  ${dim("Remote:")}       ${dim(shortenRemoteUrl(git.remoteUrl))}`,
      );
    }
  } else {
    lines.push(`  ${dim("Git:")}          ${dim("not a repository")}`);
  }
  lines.push("");

  // Session stats
  lines.push(`  ${dim("Scans:")}        ${white(String(info.scanCount))}`);
  lines.push(`  ${dim("Findings:")}     ${white(String(info.findingCount))}`);
  lines.push("");

  // Display
  lines.push(`  ${dim("AI Name:")}      ${config.display.aiName}`);
  lines.push(`  ${dim("Host Name:")}    ${config.display.hostName}`);
  lines.push(
    `  ${dim("HUD:")}          ${config.display.hudEnabled ? green("enabled") : dim("disabled")}`,
  );
  lines.push(
    `  ${dim("Icon Mode:")}    ${cyan(config.display.iconMode ?? "nerd")}`,
  );
  lines.push(`  ${dim("Version:")}      ${APP_VERSION}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Render the tools list screen shown when the user types /tools.
 */
export function renderToolsScreen(
  builtinTools: Array<{ name: string; description: string }>,
  customTools: Array<{ name: string; description: string }>,
): string {
  const width = getTerminalWidth();
  const lines: string[] = [];

  lines.push("");
  lines.push(`  ${sectionHeader(`${GEAR_ICON} Available Tools`)}`);
  lines.push("");

  // Built-in tools
  lines.push(`  ${bold(cyan("Built-in Tools:"))}`);
  if (builtinTools.length === 0) {
    lines.push(`    ${dim("(none)")}`);
  } else {
    for (const tool of builtinTools) {
      lines.push(`    ${green(BULLET_POINT)} ${bold(white(tool.name))}`);
      lines.push(`      ${dim(tool.description)}`);
    }
  }
  lines.push("");

  // Custom tools
  lines.push(`  ${bold(cyan("Custom Tools:"))}`);
  if (customTools.length === 0) {
    lines.push(`    ${dim("(none — add tools to ~/.crack-code/tools/)")}`);
  } else {
    for (const tool of customTools) {
      lines.push(`    ${magenta(BULLET_POINT)} ${bold(white(tool.name))}`);
      lines.push(`      ${dim(tool.description)}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Render a findings summary card for a single finding.
 */
export function renderFindingCard(finding: {
  severity: string;
  category: string;
  title: string;
  file: string;
  line?: number;
  description: string;
  remediation: string;
  aiPrompt: string;
}): string {
  const lines: string[] = [];

  // Severity badge
  const severityColor =
    finding.severity === "critical"
      ? red
      : finding.severity === "high"
        ? red
        : finding.severity === "medium"
          ? yellow
          : finding.severity === "low"
            ? blue
            : dim;

  const severityBadge = severityColor(
    bold(`[${finding.severity.toUpperCase()}]`),
  );

  lines.push("");
  lines.push(`  ${severityBadge} ${bold(white(finding.title))}`);
  lines.push(
    `  ${dim("Category:")} ${cyan(finding.category)} ${dim("│")} ${dim("File:")} ${cyan(finding.file)}${
      finding.line ? dim(`:${finding.line}`) : ""
    }`,
  );
  lines.push("");
  lines.push(`  ${white(finding.description)}`);
  lines.push("");
  lines.push(`  ${dim("Remediation:")}`);
  lines.push(`  ${green(finding.remediation)}`);
  lines.push("");
  lines.push(`  ${dim("AI Fix Prompt:")}`);
  lines.push(`  ${italic(dim(finding.aiPrompt))}`);
  lines.push(`  ${hr(60)}`);

  return lines.join("\n");
}

/**
 * Render a scan summary with counts by severity.
 */
export function renderScanSummary(summary: {
  totalFiles: number;
  scannedFiles: number;
  totalFindings: number;
  bySeverity: Record<string, number>;
  durationMs: number;
  targetPath: string;
}): string {
  const lines: string[] = [];
  const width = getTerminalWidth();

  lines.push("");
  lines.push(`  ${sectionHeader(`${SEARCH_ICON} Scan Complete`)}`);
  lines.push("");

  // Stats
  const durationSec = (summary.durationMs / 1000).toFixed(1);
  lines.push(`  ${dim("Target:")}    ${cyan(summary.targetPath)}`);
  lines.push(
    `  ${dim("Files:")}     ${white(String(summary.scannedFiles))} ${dim(`of ${summary.totalFiles} scanned`)}`,
  );
  lines.push(`  ${dim("Duration:")}  ${white(durationSec + "s")}`);
  lines.push(
    `  ${dim("Findings:")}  ${bold(white(String(summary.totalFindings)))}`,
  );
  lines.push("");

  // Severity breakdown
  const severityOrder = ["critical", "high", "medium", "low", "info"];
  const severityColors: Record<string, (s: string) => string> = {
    critical: red,
    high: red,
    medium: yellow,
    low: blue,
    info: dim,
  };

  for (const sev of severityOrder) {
    const count = summary.bySeverity[sev] ?? 0;
    if (count > 0) {
      const colorFn = severityColors[sev] ?? dim;
      const bar = "█".repeat(Math.min(count, 30));
      lines.push(
        `  ${colorFn(sev.toUpperCase().padEnd(9))} ${colorFn(bar)} ${white(String(count))}`,
      );
    }
  }

  if (summary.totalFindings === 0) {
    lines.push(
      `  ${green(CHECK_MARK)} ${green(bold("No security issues found!"))} ${dim("Your code looks clean.")}`,
    );
  }

  lines.push("");

  return lines.join("\n");
}

/**
 * Render a streaming response indicator.
 */
export function renderStreamingIndicator(tokens: number): string {
  return `${dim(`[${tokens} tokens]`)}`;
}

// ── Warning Collection ──────────────────────────────────────────────────────

/**
 * Collect any warning messages that should be shown on the dashboard.
 */
function collectWarnings(info: DashboardInfo): string[] {
  const warnings: string[] = [];
  const { config } = info;

  // No API key
  if (config.provider.id !== AI_PROVIDER.OLLAMA && !config.provider.apiKey) {
    const envVar =
      (
        {
          anthropic: "ANTHROPIC_API_KEY",
          openai: "OPENAI_API_KEY",
          gemini: "GEMINI_API_KEY",
          cohere: "COHERE_API_KEY",
          xai: "XAI_API_KEY",
          qwen: "DASHSCOPE_API_KEY",
          moonshot: "MOONSHOT_API_KEY",
        } as Record<string, string>
      )[config.provider.id] ?? "";

    if (!process.env[envVar]) {
      warnings.push(
        `No API key configured for ${AI_PROVIDER_LABELS[config.provider.id] ?? config.provider.id}. ` +
          `Run ${COMMANDS.CONF} to set it or export ${envVar}.`,
      );
    }
  }

  // Provider unhealthy
  if (!info.providerHealthy && config.wizardCompleted) {
    warnings.push(
      `Cannot reach ${AI_PROVIDER_LABELS[config.provider.id] ?? config.provider.id}. ` +
        `Check your connection and API key.`,
    );
  }

  // No model selected
  if (!config.provider.defaultModel && config.wizardCompleted) {
    warnings.push(
      `No default model selected. Run ${COMMANDS.CONF} to choose a model.`,
    );
  }

  // Not a Git repo
  if (!info.git.isRepo) {
    warnings.push(
      "The target directory is not a Git repository. " +
        "Some features like change tracking may be limited.",
    );
  }

  return warnings;
}

// ── Utility Exports ─────────────────────────────────────────────────────────

/**
 * Create a default DashboardInfo for startup (before provider is connected).
 */
export function createDefaultDashboardInfo(
  config: CrackCodeConfig,
  targetPath: string,
): DashboardInfo {
  return {
    config,
    targetPath,
    git: detectGitStatus(targetPath),
    providerHealthy: false,
    modelCount: 0,
    scanCount: 0,
    findingCount: 0,
    mcpConnected: false,
  };
}

/**
 * Update dashboard info with fresh provider status.
 */
export function updateDashboardProvider(
  info: DashboardInfo,
  healthy: boolean,
  modelCount: number,
): DashboardInfo {
  return {
    ...info,
    providerHealthy: healthy,
    modelCount,
  };
}

/**
 * Update dashboard info with scan results.
 */
export function updateDashboardScans(
  info: DashboardInfo,
  scanCount: number,
  findingCount: number,
): DashboardInfo {
  return {
    ...info,
    scanCount,
    findingCount,
  };
}

/**
 * Update dashboard info with MCP connection status.
 */
export function updateDashboardMCP(
  info: DashboardInfo,
  connected: boolean,
): DashboardInfo {
  return {
    ...info,
    mcpConnected: connected,
  };
}
