// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Session Tracker
// ─────────────────────────────────────────────────────────────────────────────
// Tracks session-level metrics: session ID, wall time, tool call counts
// (successes/failures), API call counts and timings, agent active time,
// and renders the styled goodbye summary box on exit (Ctrl+C × 2 or
// /exit / /quit).
//
// The summary box mirrors this layout:
//
// ╭──────────────────────────────────────────────────────────────────────────╮
// │                                                                          │
// │   Crack Code — Agent powering down. Goodbye!                          │
// │                                                                          │
// │  Interaction Summary                                                     │
// │  Session ID:                 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx        │
// │  Tool Calls:                 N (  S  F )                               │
// │  Success Rate:               XX.X%                                       │
// │                                                                          │
// │  Performance                                                             │
// │  Wall Time:                  Xh Xm Xs                                    │
// │  Agent Active:               Xs                                          │
// │    » API Time:               Xs (XX.X%)                                  │
// │    » Tool Time:              Xs (XX.X%)                                  │
// │                                                                          │
// ╰──────────────────────────────────────────────────────────────────────────╯
//
// Zero external dependencies.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import {
  bold,
  dim,
  cyan,
  green,
  red,
  yellow,
  white,
  brightCyan,
  brightGreen,
  gray,
  stripAnsi,
  visibleLength,
  CHECK_MARK,
  CROSS_MARK,
  SHIELD_ICON,
} from "../utils/colors.js";

import { APP_NAME } from "../utils/constants.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** A single recorded tool call */
export interface ToolCallRecord {
  /** Tool name */
  name: string;
  /** Whether it succeeded */
  success: boolean;
  /** Duration in milliseconds */
  durationMs: number;
  /** ISO timestamp */
  timestamp: string;
  /** Error message if failed */
  error?: string;
}

/** A single recorded API call */
export interface APICallRecord {
  /** Provider ID */
  provider: string;
  /** Model ID */
  model: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether it succeeded */
  success: boolean;
  /** Tokens used (prompt + completion) */
  totalTokens: number;
  /** ISO timestamp */
  timestamp: string;
}

/** Snapshot of session metrics at any point in time */
export interface SessionSnapshot {
  sessionId: string;
  startedAt: string;
  wallTimeMs: number;
  toolCalls: {
    total: number;
    successes: number;
    failures: number;
    totalDurationMs: number;
  };
  apiCalls: {
    total: number;
    successes: number;
    failures: number;
    totalDurationMs: number;
    totalTokens: number;
  };
  agentActiveMs: number;
  apiTimeMs: number;
  toolTimeMs: number;
  scanCount: number;
  findingCount: number;
}

// ── Session Class ───────────────────────────────────────────────────────────

/**
 * Session tracker singleton.
 *
 * Create one at startup, record events throughout the session, and call
 * `renderGoodbyeSummary()` on exit to get the styled farewell box.
 */
export class Session {
  /** Unique session identifier */
  public readonly sessionId: string;

  /** ISO timestamp of session start */
  public readonly startedAt: string;

  /** Epoch ms of session start (for wall-time calculation) */
  private readonly startEpochMs: number;

  /** Recorded tool calls */
  private readonly toolCalls: ToolCallRecord[] = [];

  /** Recorded API calls */
  private readonly apiCalls: APICallRecord[] = [];

  /** Cumulative ms the agent was "actively thinking" (API + tool time) */
  private agentActiveMs: number = 0;

  /** Scans completed this session */
  private scanCount: number = 0;

  /** Findings discovered this session */
  private findingCount: number = 0;

  /** Number of Ctrl+C presses (for double-tap detection) */
  private ctrlCCount: number = 0;

  /** Timer to reset Ctrl+C count */
  private ctrlCTimer: ReturnType<typeof setTimeout> | null = null;

  /** Callback invoked when the session should terminate */
  private onExit: (() => void) | null = null;

  constructor() {
    this.sessionId = randomUUID();
    this.startedAt = new Date().toISOString();
    this.startEpochMs = Date.now();
  }

  // ── Recording ───────────────────────────────────────────────────────

  /**
   * Record a tool call.
   */
  recordToolCall(record: ToolCallRecord): void {
    this.toolCalls.push(record);
    this.agentActiveMs += record.durationMs;
  }

  /**
   * Record a successful tool call (convenience).
   */
  recordToolSuccess(name: string, durationMs: number): void {
    this.recordToolCall({
      name,
      success: true,
      durationMs,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Record a failed tool call (convenience).
   */
  recordToolFailure(name: string, durationMs: number, error: string): void {
    this.recordToolCall({
      name,
      success: false,
      durationMs,
      timestamp: new Date().toISOString(),
      error,
    });
  }

  /**
   * Record an API call.
   */
  recordAPICall(record: APICallRecord): void {
    this.apiCalls.push(record);
    this.agentActiveMs += record.durationMs;
  }

  /**
   * Record a successful API call (convenience).
   */
  recordAPISuccess(
    provider: string,
    model: string,
    durationMs: number,
    totalTokens: number,
  ): void {
    this.recordAPICall({
      provider,
      model,
      durationMs,
      success: true,
      totalTokens,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Record a failed API call (convenience).
   */
  recordAPIFailure(provider: string, model: string, durationMs: number): void {
    this.recordAPICall({
      provider,
      model,
      durationMs,
      success: false,
      totalTokens: 0,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Increment the scan counter.
   */
  recordScan(): void {
    this.scanCount++;
  }

  /**
   * Add to the finding counter.
   */
  recordFindings(count: number): void {
    this.findingCount += count;
  }

  // ── Accessors ─────────────────────────────────────────────────────────

  /**
   * Get the wall-clock time elapsed since session start (ms).
   */
  getWallTimeMs(): number {
    return Date.now() - this.startEpochMs;
  }

  /**
   * Get total tool-call duration (ms).
   */
  getToolTimeMs(): number {
    return this.toolCalls.reduce((sum, tc) => sum + tc.durationMs, 0);
  }

  /**
   * Get total API-call duration (ms).
   */
  getAPITimeMs(): number {
    return this.apiCalls.reduce((sum, ac) => sum + ac.durationMs, 0);
  }

  /**
   * Get the current session scan count.
   */
  getScanCount(): number {
    return this.scanCount;
  }

  /**
   * Get the current session finding count.
   */
  getFindingCount(): number {
    return this.findingCount;
  }

  /**
   * Capture a full snapshot of session metrics.
   */
  snapshot(): SessionSnapshot {
    const toolSuccesses = this.toolCalls.filter((tc) => tc.success).length;
    const toolFailures = this.toolCalls.filter((tc) => !tc.success).length;
    const toolDurationMs = this.getToolTimeMs();

    const apiSuccesses = this.apiCalls.filter((ac) => ac.success).length;
    const apiFailures = this.apiCalls.filter((ac) => !ac.success).length;
    const apiDurationMs = this.getAPITimeMs();
    const apiTokens = this.apiCalls.reduce((s, ac) => s + ac.totalTokens, 0);

    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      wallTimeMs: this.getWallTimeMs(),
      toolCalls: {
        total: this.toolCalls.length,
        successes: toolSuccesses,
        failures: toolFailures,
        totalDurationMs: toolDurationMs,
      },
      apiCalls: {
        total: this.apiCalls.length,
        successes: apiSuccesses,
        failures: apiFailures,
        totalDurationMs: apiDurationMs,
        totalTokens: apiTokens,
      },
      agentActiveMs: this.agentActiveMs,
      apiTimeMs: apiDurationMs,
      toolTimeMs: toolDurationMs,
      scanCount: this.scanCount,
      findingCount: this.findingCount,
    };
  }

  // ── Ctrl+C Handling ───────────────────────────────────────────────────

  /**
   * Set the exit callback and install the SIGINT (Ctrl+C) handler.
   *
   * First Ctrl+C prints a hint. Second Ctrl+C within 2 seconds triggers
   * the goodbye summary and calls the exit callback.
   */
  installExitHandler(exitCallback: () => void): void {
    this.onExit = exitCallback;

    process.on("SIGINT", () => {
      this.ctrlCCount++;

      if (this.ctrlCCount === 1) {
        // First press — hint
        if (this.ctrlCTimer) clearTimeout(this.ctrlCTimer);
        process.stdout.write(
          `\n  ${dim("Press")} ${bold(yellow("Ctrl+C"))} ${dim("again to exit.")}\n`,
        );
        // Reset after 2 seconds
        this.ctrlCTimer = setTimeout(() => {
          this.ctrlCCount = 0;
        }, 2000);
      } else {
        // Second press — goodbye
        if (this.ctrlCTimer) {
          clearTimeout(this.ctrlCTimer);
          this.ctrlCTimer = null;
        }
        this.ctrlCCount = 0;
        this.exit();
      }
    });
  }

  /**
   * Trigger a graceful exit: render summary, invoke callback.
   */
  exit(): void {
    const summary = this.renderGoodbyeSummary();
    process.stdout.write("\n" + summary + "\n\n");
    if (this.onExit) {
      this.onExit();
    }
  }

  // ── Goodbye Summary Rendering ─────────────────────────────────────────

  /**
   * Render the styled goodbye summary box.
   *
   * Uses the ╭/╰ box-drawing characters and internal styled lines to
   * produce the farewell card the user sees on exit.
   */
  renderGoodbyeSummary(): string {
    const snap = this.snapshot();

    // ── Compute display values ────────────────────────────────────────

    const wallTimeStr = formatDuration(snap.wallTimeMs);
    const agentActiveStr = formatDuration(snap.agentActiveMs);
    const apiTimeStr = formatDuration(snap.apiTimeMs);
    const toolTimeStr = formatDuration(snap.toolTimeMs);

    const apiPct =
      snap.agentActiveMs > 0
        ? ((snap.apiTimeMs / snap.agentActiveMs) * 100).toFixed(1)
        : "0.0";
    const toolPct =
      snap.agentActiveMs > 0
        ? ((snap.toolTimeMs / snap.agentActiveMs) * 100).toFixed(1)
        : "0.0";

    const toolTotal = snap.toolCalls.total;
    const toolOk = snap.toolCalls.successes;
    const toolFail = snap.toolCalls.failures;
    const successRate =
      toolTotal > 0 ? ((toolOk / toolTotal) * 100).toFixed(1) : "0.0";

    // ── Build content lines ───────────────────────────────────────────

    // We build an array of "raw" lines (with ANSI styling) and then
    // wrap them in the box. The box function pads each line to the
    // inner width automatically.

    const KV_LABEL_WIDTH = 28; // visible-char width for left column labels

    /**
     * Format a key-value row with aligned columns.
     * The key is dim, the value is bright.
     */
    function kvRow(label: string, value: string): string {
      const paddedLabel =
        label + " ".repeat(Math.max(0, KV_LABEL_WIDTH - label.length));
      return `${dim(paddedLabel)}${white(value)}`;
    }

    const lines: string[] = [];

    // Blank line for top padding
    lines.push("");

    // Header
    lines.push("Agent powering down. Goodbye!");

    // Blank separator
    lines.push("");

    // ── Interaction Summary ───────────────────────────────────────────

    lines.push("Interaction Summary");

    lines.push(kvRow("Session ID:", snap.sessionId));

    // Tool Calls:  N (  S  F )
    const toolCallsValue = `${toolTotal} ( ${green("✓")} ${toolOk} ${red("x")} ${toolFail} )`;
    lines.push(kvRow("Tool Calls:", toolCallsValue));

    lines.push(kvRow("Success Rate:", `${successRate}%`));

    // Blank separator
    lines.push("");

    // ── Performance ───────────────────────────────────────────────────

    lines.push("Performance");

    lines.push(kvRow("Wall Time:", wallTimeStr));
    lines.push(kvRow("Agent Active:", agentActiveStr));
    lines.push(kvRow(`  » API Time:`, `${apiTimeStr} (${apiPct}%)`));
    lines.push(kvRow(`  » Tool Time:`, `${toolTimeStr} (${toolPct}%)`));

    // If there were API calls, show token usage
    if (snap.apiCalls.total > 0) {
      lines.push("");
      lines.push("Token Usage");
      lines.push(
        kvRow(
          "API Calls:",
          `${snap.apiCalls.total} ( ${green("✓")} ${snap.apiCalls.successes} ${red("x")} ${snap.apiCalls.failures} )`,
        ),
      );
      lines.push(
        kvRow("Total Tokens:", formatNumber(snap.apiCalls.totalTokens)),
      );
    }

    // If there were scans, show scan stats
    if (snap.scanCount > 0) {
      lines.push("");
      lines.push("Scan Results");
      lines.push(kvRow("Scans Completed:", String(snap.scanCount)));
      lines.push(kvRow("Findings:", String(snap.findingCount)));
    }

    // Bottom padding
    lines.push("");

    // ── Wrap in box ───────────────────────────────────────────────────

    return renderSummaryBox(lines);
  }
}

// ── Box Renderer ──────────────────────────────────────────────────────────────
//
// We use our own minimal box renderer here rather than the one in colors.ts
// so we have precise control over the width, padding, and the visual style
// matching the reference design.
//

/**
 * Render lines inside a ╭╮╰╯ box with consistent inner width.
 */
function renderSummaryBox(contentLines: string[]): string {
  const PADDING = 2; // spaces on each side of content

  // Determine the inner width from the longest visible line
  let maxVisible = 0;
  for (const line of contentLines) {
    const len = visibleLength(line);
    if (len > maxVisible) maxVisible = len;
  }

  // Clamp to a reasonable range — at least 70, at most terminal width - 4
  const termCols = (process.stdout as NodeJS.WriteStream).columns || 100;
  const innerWidth = Math.max(
    70,
    Math.min(maxVisible + PADDING * 2, termCols - 4),
  );

  const totalInner = innerWidth; // characters between │ and │

  const output: string[] = [];
  const borderColor = dim;

  // Top border
  output.push(borderColor("╭" + "─".repeat(totalInner) + "╮"));

  // Content lines
  for (const line of contentLines) {
    const vis = visibleLength(line);
    const rightPad = Math.max(0, totalInner - PADDING * 2 - vis);
    output.push(
      borderColor("│") +
        " ".repeat(PADDING) +
        line +
        " ".repeat(rightPad) +
        " ".repeat(PADDING) +
        borderColor("│"),
    );
  }

  // Bottom border
  output.push(borderColor("╰" + "─".repeat(totalInner) + "╯"));

  return output.join("\n");
}

// ── Duration / Number Formatting ────────────────────────────────────────────

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * Examples:
 *   0         → "0s"
 *   3_500     → "3s"
 *   67_000    → "1m 7s"
 *   3_600_000 → "1h 0m 0s"
 *   4_053_000 → "1h 7m 33s"
 */
function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;

  const totalSeconds = Math.floor(ms / 1000);

  if (totalSeconds === 0) {
    return "0s";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
  } else if (minutes > 0) {
    parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
  } else {
    parts.push(`${seconds}s`);
  }

  return parts.join(" ");
}

/**
 * Format a number with comma separators for readability.
 *
 * Examples:
 *   1234    → "1,234"
 *   1000000 → "1,000,000"
 */
function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

// ── Singleton ───────────────────────────────────────────────────────────────

/**
 * Global session instance.
 *
 * Initialized lazily via `getSession()` or explicitly via `createSession()`.
 * There is exactly one session per process lifetime.
 */
let globalSession: Session | null = null;

/**
 * Create and store the global session. Subsequent calls return the same
 * instance (the first creation wins).
 */
export function createSession(): Session {
  if (!globalSession) {
    globalSession = new Session();
  }
  return globalSession;
}

/**
 * Get the global session. Creates one if it doesn't exist yet.
 */
export function getSession(): Session {
  return createSession();
}

/**
 * Reset the global session (primarily for testing).
 */
export function resetSession(): void {
  globalSession = null;
}
