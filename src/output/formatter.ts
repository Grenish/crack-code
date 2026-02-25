// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Output Formatter
// ─────────────────────────────────────────────────────────────────────────────
// Formats findings, scan summaries, and analysis results for rich terminal
// display. Produces ANSI-styled output using the project's color utilities.
//
// This module is purely presentational — it takes structured data and
// returns styled strings. It never modifies source files or performs I/O
// beyond writing to stdout when explicitly asked.
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
  gray,
  blue,
  magenta,
  brightCyan,
  brightGreen,
  brightYellow,
  brightRed,
  brightMagenta,
  brightBlue,
  italic,
  underline,
  stripAnsi,
  visibleLength,
  padStyled,
  sectionHeader,
  kvPair,
  box,
  SHIELD_ICON,
  BUG_ICON,
  LOCK_ICON,
  SEARCH_ICON,
  GEAR_ICON,
  FOLDER_ICON,
  FILE_ICON,
  CHECK_MARK,
  CROSS_MARK,
  WARNING_MARK,
  ARROW_RIGHT,
  ARROW_DOWN,
  BULLET_POINT,
  INFO_MARK,
} from "../utils/colors.js";

import {
  SEVERITY,
  SEVERITY_LABELS,
  SEVERITY_ORDER,
  type Severity,
  type VulnCategory,
  APP_NAME,
} from "../utils/constants.js";

import type {
  Finding,
  AffectedLocation,
  FindingsSummary,
  FindingSource,
} from "./findings.js";

import {
  formatCategoryLabel,
  getSeverityLabel,
  countBySeverity,
  countByCategory,
  getAffectedFiles,
  highestSeverity,
  summarizeFindings,
} from "./findings.js";

// ── Terminal Helpers ─────────────────────────────────────────────────────────

/** Get clamped terminal width */
function getTermWidth(): number {
  const cols = (process.stdout as NodeJS.WriteStream).columns || 80;
  return Math.max(60, Math.min(cols, 120));
}

/** Horizontal rule */
function hr(width: number, char: string = "─"): string {
  return dim(char.repeat(width));
}

/** Center text within width */
function center(text: string, width: number): string {
  const vis = visibleLength(text);
  if (vis >= width) return text;
  const left = Math.floor((width - vis) / 2);
  return " ".repeat(left) + text;
}

/** Right-pad accounting for ANSI codes */
function pad(text: string, width: number): string {
  const vis = visibleLength(text);
  if (vis >= width) return text;
  return text + " ".repeat(width - vis);
}

// ── Severity Styling ────────────────────────────────────────────────────────

/**
 * Get the color function for a severity level.
 */
function severityColor(severity: Severity): (text: string) => string {
  switch (severity) {
    case SEVERITY.CRITICAL:
      return brightRed;
    case SEVERITY.HIGH:
      return red;
    case SEVERITY.MEDIUM:
      return yellow;
    case SEVERITY.LOW:
      return blue;
    case SEVERITY.INFO:
      return dim;
    default:
      return white;
  }
}

/**
 * Render a severity badge like [CRITICAL] or [HIGH] in the appropriate color.
 */
export function renderSeverityBadge(severity: Severity): string {
  const color = severityColor(severity);
  const label = getSeverityLabel(severity);
  return color(bold(`[${label}]`));
}

/**
 * Render a small severity dot indicator.
 */
export function renderSeverityDot(severity: Severity): string {
  const color = severityColor(severity);
  return color("●");
}

/**
 * Render a severity bar (visual indicator of relative severity).
 */
export function renderSeverityBar(severity: Severity): string {
  const levels: Record<string, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
    info: 1,
  };
  const level = levels[severity] ?? 0;
  const color = severityColor(severity);
  const filled = color("█".repeat(level));
  const empty = dim("░".repeat(5 - level));
  return filled + empty;
}

// ── Finding Card ────────────────────────────────────────────────────────────

/**
 * Render a single finding as a detailed card for terminal display.
 *
 * Layout:
 *   [SEVERITY] Title
 *   Category: Xxx │ File: path/to/file.ts:42
 *
 *   Description text...
 *
 *   Remediation:
 *   Step-by-step guidance...
 *
 *   AI Fix Prompt:
 *   Ready-to-use prompt...
 *   ──────────────────────────────────────
 */
export function formatFindingCard(finding: Finding, index?: number): string {
  const width = getTermWidth();
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────

  const badge = renderSeverityBadge(finding.severity);
  const indexPrefix = index !== undefined ? dim(`#${index + 1} `) : "";

  lines.push("");
  lines.push(`  ${indexPrefix}${badge} ${bold(white(finding.title))}`);

  // Category │ File(s) │ Confidence
  const categoryStr = cyan(formatCategoryLabel(finding.category));
  const locationStr = formatLocationBrief(finding.locations);
  const confStr = formatConfidence(finding.confidence);

  lines.push(
    `  ${dim("Category:")} ${categoryStr} ${dim("│")} ${dim("File:")} ${cyan(locationStr)} ${dim("│")} ${confStr}`,
  );

  // CWE / OWASP tags
  const tags: string[] = [];
  if (finding.cweIds.length > 0) {
    tags.push(dim("CWE: ") + yellow(finding.cweIds.join(", ")));
  }
  if (finding.owaspCategory) {
    tags.push(dim("OWASP: ") + yellow(finding.owaspCategory));
  }
  if (tags.length > 0) {
    lines.push(`  ${tags.join(dim(" │ "))}`);
  }

  lines.push("");

  // ── Description ─────────────────────────────────────────────────────

  const descLines = wordWrap(finding.description, width - 6);
  for (const line of descLines) {
    lines.push(`  ${white(line)}`);
  }

  // ── Code Snippets ───────────────────────────────────────────────────

  const snippetLocations = finding.locations.filter((loc) => loc.snippet);
  if (snippetLocations.length > 0) {
    lines.push("");
    lines.push(`  ${dim("Affected Code:")}`);
    for (const loc of snippetLocations) {
      const fileRef = dim(
        `  ${loc.file}${loc.startLine ? `:${loc.startLine}` : ""}`,
      );
      lines.push(`  ${fileRef}`);
      const snippetLines = (loc.snippet ?? "").split("\n");
      for (const sl of snippetLines.slice(0, 10)) {
        lines.push(`  ${dim("│")} ${gray(sl)}`);
      }
      if (snippetLines.length > 10) {
        lines.push(
          `  ${dim("│")} ${dim(`... (${snippetLines.length - 10} more lines)`)}`,
        );
      }
    }
  }

  // ── Remediation ─────────────────────────────────────────────────────

  lines.push("");
  lines.push(`  ${bold(green("Remediation:"))}`);
  const remLines = wordWrap(finding.remediation, width - 6);
  for (const line of remLines) {
    lines.push(`  ${green(line)}`);
  }

  // ── AI Prompt ───────────────────────────────────────────────────────

  if (finding.aiPrompt) {
    lines.push("");
    lines.push(`  ${bold(brightCyan("AI Fix Prompt:"))}`);
    // Show first few lines of the prompt, truncated
    const promptLines = finding.aiPrompt.split("\n").slice(0, 6);
    for (const line of promptLines) {
      lines.push(`  ${italic(dim(line))}`);
    }
    if (finding.aiPrompt.split("\n").length > 6) {
      lines.push(`  ${dim("... (use /report to see full prompt)")}`);
    }
  }

  // ── References ──────────────────────────────────────────────────────

  if (finding.references.length > 0) {
    lines.push("");
    lines.push(`  ${dim("References:")}`);
    for (const ref of finding.references.slice(0, 5)) {
      lines.push(`    ${dim(BULLET_POINT)} ${dim(underline(ref))}`);
    }
  }

  // ── Separator ───────────────────────────────────────────────────────

  lines.push(`  ${hr(width - 4)}`);

  return lines.join("\n");
}

/**
 * Render a compact one-line summary of a finding (for lists).
 */
export function formatFindingOneLiner(
  finding: Finding,
  index?: number,
): string {
  const badge = renderSeverityBadge(finding.severity);
  const loc = formatLocationBrief(finding.locations);
  const idxStr =
    index !== undefined ? dim(`${String(index + 1).padStart(3)}.`) : "";

  return `${idxStr} ${badge} ${white(finding.title)} ${dim("in")} ${cyan(loc)}`;
}

/**
 * Render a medium-detail finding summary (2–3 lines).
 */
export function formatFindingMedium(finding: Finding, index?: number): string {
  const lines: string[] = [];
  const badge = renderSeverityBadge(finding.severity);
  const loc = formatLocationBrief(finding.locations);
  const idxStr =
    index !== undefined ? dim(`${String(index + 1).padStart(3)}.`) : "";

  lines.push(`${idxStr} ${badge} ${bold(white(finding.title))}`);
  lines.push(
    `     ${dim("Category:")} ${cyan(formatCategoryLabel(finding.category))} ${dim("│")} ` +
      `${dim("File:")} ${cyan(loc)} ${dim("│")} ${formatConfidence(finding.confidence)}`,
  );

  // Truncated description
  const desc =
    finding.description.length > 120
      ? finding.description.slice(0, 117) + "..."
      : finding.description;
  lines.push(`     ${dim(desc)}`);

  return lines.join("\n");
}

// ── Scan Summary ────────────────────────────────────────────────────────────

/**
 * Options for rendering a scan summary.
 */
export interface ScanSummaryInput {
  /** Total files discovered */
  totalFiles: number;
  /** Files that were actually scanned/analyzed */
  scannedFiles: number;
  /** Files skipped (too large, binary, ignored) */
  skippedFiles: number;
  /** Total findings */
  totalFindings: number;
  /** Findings grouped by severity */
  bySeverity: Record<string, number>;
  /** Findings grouped by category */
  byCategory?: Record<string, number>;
  /** Duration of the scan in milliseconds */
  durationMs: number;
  /** Target path that was scanned */
  targetPath: string;
  /** Affected files (deduplicated) */
  affectedFiles?: string[];
}

/**
 * Render a comprehensive scan summary card.
 */
export function formatScanSummary(input: ScanSummaryInput): string {
  const width = getTermWidth();
  const lines: string[] = [];

  lines.push("");
  lines.push(`  ${sectionHeader(`${SEARCH_ICON} Scan Complete`)}`);
  lines.push("");

  // ── Stats Row ───────────────────────────────────────────────────────

  const durationSec = (input.durationMs / 1000).toFixed(1);

  lines.push(
    `  ${dim("Target:")}      ${bold(cyan(shortenPath(input.targetPath)))}`,
  );
  lines.push(
    `  ${dim("Files:")}       ${white(String(input.scannedFiles))} ${dim("scanned")} ${dim("/")} ` +
      `${dim(String(input.totalFiles))} ${dim("total")}` +
      (input.skippedFiles > 0
        ? ` ${dim("(")}${yellow(String(input.skippedFiles))} ${dim("skipped)")}`
        : ""),
  );
  lines.push(`  ${dim("Duration:")}    ${white(durationSec + "s")}`);
  lines.push(
    `  ${dim("Findings:")}    ${bold(white(String(input.totalFindings)))}`,
  );
  lines.push("");

  // ── Severity Breakdown ──────────────────────────────────────────────

  const severityOrder: Severity[] = [
    SEVERITY.CRITICAL,
    SEVERITY.HIGH,
    SEVERITY.MEDIUM,
    SEVERITY.LOW,
    SEVERITY.INFO,
  ];

  let hasAnySeverity = false;

  for (const sev of severityOrder) {
    const count = input.bySeverity[sev] ?? 0;
    if (count > 0) {
      hasAnySeverity = true;
      const color = severityColor(sev);
      const label = getSeverityLabel(sev).padEnd(9);
      const barLen = Math.min(count, 40);
      const bar = color("█".repeat(barLen));
      lines.push(`  ${color(label)} ${bar} ${white(String(count))}`);
    }
  }

  if (!hasAnySeverity && input.totalFindings === 0) {
    lines.push(
      `  ${green(CHECK_MARK)} ${bold(green("No security issues found!"))} ${dim("Your code looks clean.")}`,
    );
  }

  // ── Category Breakdown (if available and there are findings) ───────

  if (input.byCategory && input.totalFindings > 0) {
    const categories = Object.entries(input.byCategory)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8);

    if (categories.length > 0) {
      lines.push("");
      lines.push(`  ${dim("By Category:")}`);
      for (const [cat, count] of categories) {
        const label = formatCategoryLabel(cat as VulnCategory);
        lines.push(
          `    ${dim(BULLET_POINT)} ${white(label)} ${dim("—")} ${white(String(count))}`,
        );
      }
    }
  }

  // ── Affected Files (top N) ────────────────────────────────────────

  if (input.affectedFiles && input.affectedFiles.length > 0) {
    lines.push("");
    lines.push(`  ${dim("Top Affected Files:")}`);
    const topFiles = input.affectedFiles.slice(0, 8);
    for (const file of topFiles) {
      lines.push(`    ${FILE_ICON} ${cyan(file)}`);
    }
    if (input.affectedFiles.length > 8) {
      lines.push(
        `    ${dim(`... and ${input.affectedFiles.length - 8} more`)}`,
      );
    }
  }

  lines.push("");

  return lines.join("\n");
}

/**
 * Render a minimal inline scan progress line (for updates during scanning).
 */
export function formatScanProgress(
  scannedFiles: number,
  totalFiles: number,
  currentFile?: string,
): string {
  const pct =
    totalFiles > 0 ? Math.round((scannedFiles / totalFiles) * 100) : 0;

  const barWidth = 25;
  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = green("█".repeat(filled)) + dim("░".repeat(empty));

  let line = `  ${bar} ${white(String(pct) + "%")} ${dim(`(${scannedFiles}/${totalFiles})`)}`;

  if (currentFile) {
    const short =
      currentFile.length > 35 ? "..." + currentFile.slice(-32) : currentFile;
    line += ` ${dim(short)}`;
  }

  return line;
}

// ── Findings List ───────────────────────────────────────────────────────────

/**
 * Render a list of findings with headers and grouping.
 *
 * @param findings - The findings to render.
 * @param format   - Level of detail: "full" | "medium" | "compact"
 * @param groupBy  - Group by: "severity" | "category" | "file" | "none"
 */
export function formatFindingsList(
  findings: Finding[],
  format: "full" | "medium" | "compact" = "medium",
  groupBy: "severity" | "category" | "file" | "none" = "severity",
): string {
  if (findings.length === 0) {
    return `\n  ${green(CHECK_MARK)} ${dim("No findings to display.")}\n`;
  }

  const width = getTermWidth();
  const lines: string[] = [];

  lines.push("");
  lines.push(
    `  ${sectionHeader(
      `${BUG_ICON} ${findings.length} Finding${findings.length !== 1 ? "s" : ""}`,
    )}`,
  );

  if (groupBy === "none") {
    for (let i = 0; i < findings.length; i++) {
      lines.push(formatByDetail(findings[i]!, format, i));
    }
  } else {
    const groups = groupFindings(findings, groupBy);
    for (const [groupLabel, groupFindings_] of groups) {
      lines.push("");
      lines.push(`  ${bold(brightCyan(groupLabel))}`);
      for (let i = 0; i < groupFindings_.length; i++) {
        lines.push(formatByDetail(groupFindings_[i]!, format, i));
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Select the appropriate format function based on detail level.
 */
function formatByDetail(
  finding: Finding,
  format: "full" | "medium" | "compact",
  index: number,
): string {
  switch (format) {
    case "full":
      return formatFindingCard(finding, index);
    case "medium":
      return formatFindingMedium(finding, index);
    case "compact":
      return formatFindingOneLiner(finding, index);
  }
}

/**
 * Group findings by the specified field.
 */
function groupFindings(
  findings: Finding[],
  groupBy: "severity" | "category" | "file",
): Array<[string, Finding[]]> {
  const groups = new Map<string, Finding[]>();

  for (const f of findings) {
    let key: string;
    switch (groupBy) {
      case "severity":
        key = getSeverityLabel(f.severity);
        break;
      case "category":
        key = formatCategoryLabel(f.category);
        break;
      case "file":
        key = f.locations[0]?.file ?? "(unknown file)";
        break;
    }

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(f);
  }

  // Sort groups by severity order if grouping by severity
  if (groupBy === "severity") {
    const sevOrder = SEVERITY_ORDER.map((s) => getSeverityLabel(s));
    const entries = Array.from(groups.entries());
    entries.sort((a, b) => {
      const idxA = sevOrder.indexOf(a[0]);
      const idxB = sevOrder.indexOf(b[0]);
      return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
    });
    return entries;
  }

  // Sort other groups by count (descending)
  const entries = Array.from(groups.entries());
  entries.sort((a, b) => b[1].length - a[1].length);
  return entries;
}

// ── Report Header / Footer ──────────────────────────────────────────────────

/**
 * Render the header for a full report.
 */
export function formatReportHeader(
  targetPath: string,
  timestamp: string,
): string {
  const width = getTermWidth();
  const lines: string[] = [];

  lines.push("");
  lines.push(
    center(
      `${SHIELD_ICON} ${bold(brightCyan(APP_NAME))} ${dim("— Security Analysis Report")}`,
      width,
    ),
  );
  lines.push(center(hr(50), width));
  lines.push(
    center(
      `${dim("Target:")} ${cyan(shortenPath(targetPath))} ${dim("│")} ${dim("Generated:")} ${dim(timestamp)}`,
      width,
    ),
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Render the footer for a full report.
 */
export function formatReportFooter(): string {
  const width = getTermWidth();
  const lines: string[] = [];

  lines.push("");
  lines.push(`  ${hr(width - 4)}`);
  lines.push(
    center(
      dim(
        `${SHIELD_ICON} Generated by ${APP_NAME} — Remember: this tool never modifies your source files.`,
      ),
      width,
    ),
  );
  lines.push(
    center(
      dim(
        "Findings include severity, classification, remediation guidance, and ready-to-use AI prompts.",
      ),
      width,
    ),
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Render a complete report (header + summary + findings list + footer).
 */
export function formatFullReport(
  findings: Finding[],
  scanMeta: ScanSummaryInput,
): string {
  const timestamp = new Date().toISOString().split("T")[0] ?? "";

  const parts: string[] = [];
  parts.push(formatReportHeader(scanMeta.targetPath, timestamp));
  parts.push(formatScanSummary(scanMeta));
  parts.push(formatFindingsList(findings, "full", "severity"));
  parts.push(formatReportFooter());

  return parts.join("");
}

// ── Streaming Output ────────────────────────────────────────────────────────

/**
 * Render an inline streaming token indicator.
 */
export function formatStreamingIndicator(tokens: number): string {
  return dim(` [${tokens} tokens]`);
}

/**
 * Render the agent's thinking/processing indicator.
 */
export function formatThinkingIndicator(toolName?: string): string {
  if (toolName) {
    return dim(`  ${GEAR_ICON} Using tool: ${cyan(toolName)}...`);
  }
  return dim(`  ${GEAR_ICON} Analyzing...`);
}

/**
 * Render a tool call start message.
 */
export function formatToolCallStart(
  toolName: string,
  args?: Record<string, unknown>,
): string {
  const lines: string[] = [];
  lines.push(`  ${dim(ARROW_RIGHT)} ${cyan(toolName)}`);
  if (args && Object.keys(args).length > 0) {
    const argStr = Object.entries(args)
      .map(([k, v]) => `${dim(k)}=${dim(JSON.stringify(v))}`)
      .join(" ");
    lines.push(`    ${dim(argStr)}`);
  }
  return lines.join("\n");
}

/**
 * Render a tool call result message.
 */
export function formatToolCallResult(
  toolName: string,
  success: boolean,
  durationMs: number,
  preview?: string,
): string {
  const status = success ? green(CHECK_MARK) : red(CROSS_MARK);
  const dur = dim(`(${(durationMs / 1000).toFixed(1)}s)`);
  const lines: string[] = [];

  lines.push(`  ${status} ${cyan(toolName)} ${dur}`);

  if (preview) {
    const previewLines = preview.split("\n").slice(0, 3);
    for (const pl of previewLines) {
      const truncated = pl.length > 80 ? pl.slice(0, 77) + "..." : pl;
      lines.push(`    ${dim(truncated)}`);
    }
  }

  return lines.join("\n");
}

// ── Agent Response ──────────────────────────────────────────────────────────

/**
 * Render the agent's text response with proper indentation and styling.
 */
export function formatAgentResponse(text: string): string {
  const width = getTermWidth();
  const lines: string[] = [];

  lines.push("");

  // Split by paragraphs and wrap
  const paragraphs = text.split(/\n\n+/);
  for (const para of paragraphs) {
    if (para.trim().startsWith("```")) {
      // Code block — render as-is with dim styling
      const codeLines = para.split("\n");
      for (const cl of codeLines) {
        lines.push(`  ${dim("│")} ${gray(cl)}`);
      }
    } else if (para.trim().startsWith("- ") || para.trim().startsWith("* ")) {
      // List items
      const items = para.split("\n");
      for (const item of items) {
        const trimmed = item.trim();
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          lines.push(`  ${green(BULLET_POINT)} ${white(trimmed.slice(2))}`);
        } else {
          lines.push(`    ${white(trimmed)}`);
        }
      }
    } else if (para.trim().startsWith("#")) {
      // Markdown headings
      const heading = para.trim().replace(/^#+\s*/, "");
      lines.push(`  ${bold(brightCyan(heading))}`);
    } else {
      // Regular paragraph
      const wrapped = wordWrap(para.trim(), width - 4);
      for (const wl of wrapped) {
        lines.push(`  ${white(wl)}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Render an error message from the agent or provider.
 */
export function formatAgentError(error: string): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${red(CROSS_MARK)} ${bold(red("Error"))}`);

  const wrapped = wordWrap(error, getTermWidth() - 6);
  for (const line of wrapped) {
    lines.push(`  ${red(line)}`);
  }

  lines.push("");
  return lines.join("\n");
}

// ── Utility ─────────────────────────────────────────────────────────────────

/**
 * Format a location array into a brief string for inline display.
 *
 * Examples:
 *   "src/auth.ts:42"
 *   "src/auth.ts:42-58"
 *   "src/auth.ts:42, src/db.ts:10 (+2 more)"
 */
function formatLocationBrief(locations: AffectedLocation[]): string {
  if (locations.length === 0) return "(unknown)";

  const parts: string[] = [];
  const maxShow = 2;

  for (let i = 0; i < Math.min(locations.length, maxShow); i++) {
    const loc = locations[i]!;
    let s = loc.file;
    if (loc.startLine) {
      s += `:${loc.startLine}`;
      if (loc.endLine && loc.endLine !== loc.startLine) {
        s += `-${loc.endLine}`;
      }
    }
    parts.push(s);
  }

  let result = parts.join(", ");
  if (locations.length > maxShow) {
    result += ` (+${locations.length - maxShow} more)`;
  }

  return result;
}

/**
 * Format a confidence value as a percentage with a visual indicator.
 */
function formatConfidence(confidence: number): string {
  const pct = Math.round(confidence * 100);
  const color = pct >= 80 ? green : pct >= 50 ? yellow : red;
  return `${dim("Conf:")} ${color(pct + "%")}`;
}

/**
 * Shorten a file path for display (replace $HOME with ~).
 */
function shortenPath(path: string): string {
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
  if (home && path.startsWith(home)) {
    return "~" + path.slice(home.length);
  }
  return path;
}

/**
 * Word-wrap text to a maximum width, respecting word boundaries.
 */
function wordWrap(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];

  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    // If adding this word exceeds the width
    if (currentLine.length > 0 && currentLine.length + word.length > maxWidth) {
      lines.push(currentLine.trimEnd());
      currentLine = word.trimStart();
    } else {
      currentLine += word;
    }
  }

  if (currentLine.trim()) {
    lines.push(currentLine.trimEnd());
  }

  return lines.length > 0 ? lines : [""];
}

/**
 * Render a "no findings" message with style.
 */
export function formatNoFindings(): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `  ${green(CHECK_MARK)} ${bold(green("All clear!"))} ${dim("No security issues were detected.")}`,
  );
  lines.push(
    `  ${dim("This doesn't guarantee your code is vulnerability-free —")}`,
  );
  lines.push(
    `  ${dim("consider manual review for logic flaws and business-specific risks.")}`,
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * Render a divider between sections.
 */
export function formatDivider(title?: string): string {
  const width = getTermWidth();
  if (title) {
    return `\n  ${sectionHeader(title)}\n`;
  }
  return `\n  ${hr(width - 4)}\n`;
}

/**
 * Render a key-value pair row for tables/summaries.
 */
export function formatKV(
  key: string,
  value: string,
  keyWidth: number = 18,
): string {
  const paddedKey = key.padEnd(keyWidth);
  return `  ${dim(paddedKey)} ${white(value)}`;
}

/**
 * Render a compact findings summary (for dashboard / status).
 */
export function formatFindingsCompact(summary: FindingsSummary): string {
  const parts: string[] = [];

  const sevParts: string[] = [];
  for (const sev of SEVERITY_ORDER) {
    const count = summary.bySeverity[sev] ?? 0;
    if (count > 0) {
      const color = severityColor(sev);
      sevParts.push(color(`${count} ${getSeverityLabel(sev).toLowerCase()}`));
    }
  }

  if (sevParts.length > 0) {
    parts.push(sevParts.join(dim(" │ ")));
  } else {
    parts.push(green("clean"));
  }

  return parts.join("");
}
