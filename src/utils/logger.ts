// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Logger Utility
// ─────────────────────────────────────────────────────────────────────────────
// Provides leveled logging (debug, info, warn, error, success), an animated
// spinner for async operations, and a simple progress bar — all built with
// raw ANSI escape sequences. Zero external dependencies.
// ─────────────────────────────────────────────────────────────────────────────

import {
  bold,
  dim,
  red,
  green,
  yellow,
  cyan,
  gray,
  white,
  brightGreen,
  brightRed,
  brightYellow,
  brightCyan,
  stripAnsi,
  visibleLength,
  clearEntireLine,
  cursorTo,
  cursorHide,
  cursorShow,
  SPINNER_FRAMES,
  CHECK_MARK,
  CROSS_MARK,
  WARNING_MARK,
  INFO_MARK,
  BULLET_POINT,
} from "./colors.js";

// ── Log Levels ──────────────────────────────────────────────────────────────

export const LOG_LEVEL = {
  SILENT: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  SUCCESS: 3,
  DEBUG: 4,
  TRACE: 5,
} as const;

export type LogLevelName = keyof typeof LOG_LEVEL;
export type LogLevelValue = (typeof LOG_LEVEL)[LogLevelName];

// ── Logger State ────────────────────────────────────────────────────────────

let currentLevel: LogLevelValue = LOG_LEVEL.INFO;
let logTimestamps = false;
let logPrefix = "";

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * Set the minimum log level. Messages below this level are suppressed.
 */
export function setLogLevel(level: LogLevelValue): void {
  currentLevel = level;
}

/**
 * Get the current log level.
 */
export function getLogLevel(): LogLevelValue {
  return currentLevel;
}

/**
 * Parse a log level name string into its numeric value.
 */
export function parseLogLevel(name: string): LogLevelValue {
  const upper = name.toUpperCase() as LogLevelName;
  if (upper in LOG_LEVEL) {
    return LOG_LEVEL[upper];
  }
  return LOG_LEVEL.INFO;
}

/**
 * Enable or disable timestamps on log messages.
 */
export function setLogTimestamps(enabled: boolean): void {
  logTimestamps = enabled;
}

/**
 * Set an optional prefix prepended to every log line (e.g., "[crack-code]").
 */
export function setLogPrefix(prefix: string): void {
  logPrefix = prefix;
}

// ── Internal Helpers ────────────────────────────────────────────────────────

function timestamp(): string {
  if (!logTimestamps) return "";
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return dim(gray(`[${h}:${m}:${s}.${ms}]`)) + " ";
}

function prefix(): string {
  if (!logPrefix) return "";
  return dim(gray(logPrefix)) + " ";
}

function write(stream: NodeJS.WriteStream, ...args: unknown[]): void {
  const parts = args.map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack ?? a.message;
    try {
      return JSON.stringify(a, null, 2);
    } catch {
      return String(a);
    }
  });
  stream.write(timestamp() + prefix() + parts.join(" ") + "\n");
}

// ── Leveled Log Functions ───────────────────────────────────────────────────

/**
 * Log a debug message — only visible at LOG_LEVEL.DEBUG or higher.
 */
export function debug(...args: unknown[]): void {
  if (currentLevel < LOG_LEVEL.DEBUG) return;
  const badge = dim(gray(`${BULLET_POINT} DEBUG`));
  write(process.stderr, badge, ...args);
}

/**
 * Log a trace message — most verbose level.
 */
export function trace(...args: unknown[]): void {
  if (currentLevel < LOG_LEVEL.TRACE) return;
  const badge = dim(gray(`  TRACE`));
  write(process.stderr, badge, ...args);
}

/**
 * Log an informational message.
 */
export function info(...args: unknown[]): void {
  if (currentLevel < LOG_LEVEL.INFO) return;
  const badge = bold(cyan(`${INFO_MARK}`));
  write(process.stdout, badge, ...args);
}

/**
 * Log a success message.
 */
export function success(...args: unknown[]): void {
  if (currentLevel < LOG_LEVEL.SUCCESS) return;
  const badge = bold(green(`${CHECK_MARK}`));
  write(process.stdout, badge, ...args);
}

/**
 * Log a warning message.
 */
export function warn(...args: unknown[]): void {
  if (currentLevel < LOG_LEVEL.WARN) return;
  const badge = bold(yellow(`${WARNING_MARK}`));
  write(process.stderr, badge, ...args);
}

/**
 * Log an error message.
 */
export function error(...args: unknown[]): void {
  if (currentLevel < LOG_LEVEL.ERROR) return;
  const badge = bold(red(`${CROSS_MARK}`));
  write(process.stderr, badge, ...args);
}

/**
 * Always prints to stdout regardless of log level (for TUI output).
 */
export function raw(text: string): void {
  process.stdout.write(text);
}

/**
 * Always prints a line to stdout regardless of log level (for TUI output).
 */
export function rawLine(text: string = ""): void {
  process.stdout.write(text + "\n");
}

/**
 * Print a blank line to stdout.
 */
export function blank(): void {
  process.stdout.write("\n");
}

// ── Structured Output ───────────────────────────────────────────────────────

/**
 * Log a key-value pair with consistent alignment.
 */
export function kvLog(key: string, val: string, keyWidth: number = 18): void {
  if (currentLevel < LOG_LEVEL.INFO) return;
  const paddedKey = key.padEnd(keyWidth);
  rawLine(`  ${bold(white(paddedKey))} ${cyan(val)}`);
}

/**
 * Log a labeled section divider.
 */
export function section(title: string, width: number = 70): void {
  if (currentLevel < LOG_LEVEL.INFO) return;
  const lineLen = Math.max(0, width - visibleLength(title) - 4);
  rawLine(`${dim(gray("── "))}${bold(brightCyan(title))}${dim(gray(` ${"─".repeat(lineLen)}`))}`)
}

/**
 * Log a horizontal separator line.
 */
export function divider(width: number = 70): void {
  if (currentLevel < LOG_LEVEL.INFO) return;
  rawLine(dim(gray("─".repeat(width))));
}

/**
 * Log an indented list of items with bullet points.
 */
export function list(items: string[], indent: number = 2): void {
  if (currentLevel < LOG_LEVEL.INFO) return;
  const pad = " ".repeat(indent);
  for (const item of items) {
    rawLine(`${pad}${dim(yellow(BULLET_POINT))} ${item}`);
  }
}

/**
 * Log a numbered list.
 */
export function numberedList(items: string[], indent: number = 2): void {
  if (currentLevel < LOG_LEVEL.INFO) return;
  const pad = " ".repeat(indent);
  for (let i = 0; i < items.length; i++) {
    rawLine(`${pad}${dim(yellow(`${i + 1}.`))} ${items[i]}`);
  }
}

// ── Spinner ─────────────────────────────────────────────────────────────────

export interface Spinner {
  /** Update the spinner message while it's running. */
  update(message: string): void;
  /** Stop the spinner with a success check mark and message. */
  succeed(message?: string): void;
  /** Stop the spinner with an error cross mark and message. */
  fail(message?: string): void;
  /** Stop the spinner with a warning mark and message. */
  warn(message?: string): void;
  /** Stop the spinner with an info mark and message. */
  info(message?: string): void;
  /** Stop the spinner silently (no final message). */
  stop(): void;
  /** Whether the spinner is currently active. */
  readonly isSpinning: boolean;
}

/**
 * Create and start an animated terminal spinner.
 *
 * @param message - The text displayed beside the spinner animation.
 * @param interval - Frame interval in milliseconds (default 80).
 * @returns A Spinner controller object.
 *
 * @example
 * ```
 * const spin = createSpinner("Scanning files...");
 * // ... async work ...
 * spin.succeed("Scan complete!");
 * ```
 */
export function createSpinner(message: string, interval: number = 80): Spinner {
  let frameIndex = 0;
  let currentMessage = message;
  let spinning = true;
  let timer: ReturnType<typeof setInterval> | null = null;

  const isTTY = process.stderr.isTTY;

  function renderFrame(): void {
    if (!isTTY) return;
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    const line = `${clearEntireLine()}\r  ${brightCyan(frame!)} ${currentMessage}`;
    process.stderr.write(line);
    frameIndex++;
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    spinning = false;
    if (isTTY) {
      process.stderr.write(cursorShow());
    }
  }

  function finalize(icon: string, finalMessage: string): void {
    stopTimer();
    if (isTTY) {
      process.stderr.write(`${clearEntireLine()}\r  ${icon} ${finalMessage}\n`);
    } else {
      process.stderr.write(`  ${stripAnsi(icon)} ${stripAnsi(finalMessage)}\n`);
    }
  }

  // Start the spinner
  if (isTTY) {
    process.stderr.write(cursorHide());
    renderFrame();
    timer = setInterval(renderFrame, interval);
  } else {
    // Non-TTY: just print the message once
    process.stderr.write(`  ... ${message}\n`);
  }

  return {
    get isSpinning() {
      return spinning;
    },

    update(msg: string): void {
      currentMessage = msg;
      if (!isTTY && spinning) {
        process.stderr.write(`  ... ${msg}\n`);
      }
    },

    succeed(msg?: string): void {
      finalize(bold(green(CHECK_MARK)), msg ?? currentMessage);
    },

    fail(msg?: string): void {
      finalize(bold(red(CROSS_MARK)), msg ?? currentMessage);
    },

    warn(msg?: string): void {
      finalize(bold(yellow(WARNING_MARK)), msg ?? currentMessage);
    },

    info(msg?: string): void {
      finalize(bold(cyan(INFO_MARK)), msg ?? currentMessage);
    },

    stop(): void {
      stopTimer();
      if (isTTY) {
        process.stderr.write(`${clearEntireLine()}\r`);
      }
    },
  };
}

// ── Progress Bar ────────────────────────────────────────────────────────────

export interface ProgressBar {
  /** Update progress to a specific value (0–total). */
  update(current: number, message?: string): void;
  /** Increment progress by a given amount (default 1). */
  increment(amount?: number, message?: string): void;
  /** Mark the progress bar as complete. */
  complete(message?: string): void;
  /** Mark the progress bar as failed. */
  fail(message?: string): void;
  /** Current progress value. */
  readonly current: number;
  /** Total target value. */
  readonly total: number;
}

export interface ProgressBarOptions {
  /** Total number of units (default 100). */
  total?: number;
  /** Width of the progress bar in characters (default 30). */
  width?: number;
  /** Character for filled portion (default "█"). */
  fillChar?: string;
  /** Character for empty portion (default "░"). */
  emptyChar?: string;
  /** Initial message displayed beside the bar. */
  message?: string;
}

/**
 * Create a terminal progress bar.
 *
 * @example
 * ```
 * const bar = createProgressBar({ total: files.length, message: "Scanning" });
 * for (const file of files) {
 *   bar.increment(1, file.name);
 * }
 * bar.complete("Done!");
 * ```
 */
export function createProgressBar(options: ProgressBarOptions = {}): ProgressBar {
  const {
    total = 100,
    width = 30,
    fillChar = "█",
    emptyChar = "░",
    message: initialMessage = "",
  } = options;

  let currentVal = 0;
  let currentMessage = initialMessage;
  const isTTY = process.stderr.isTTY;

  function render(): void {
    const ratio = Math.min(1, Math.max(0, currentVal / total));
    const percent = Math.round(ratio * 100);
    const filled = Math.round(ratio * width);
    const empty = width - filled;

    const bar =
      brightGreen(fillChar.repeat(filled)) + dim(gray(emptyChar.repeat(empty)));

    const percentStr = `${String(percent).padStart(3)}%`;
    const countStr = `${currentVal}/${total}`;
    const msg = currentMessage ? ` ${dim(gray(currentMessage))}` : "";

    if (isTTY) {
      process.stderr.write(
        `${clearEntireLine()}\r  ${bar} ${bold(white(percentStr))} ${dim(gray(countStr))}${msg}`
      );
    }
  }

  function finalize(icon: string, finalMessage: string): void {
    if (isTTY) {
      process.stderr.write(`${clearEntireLine()}\r  ${icon} ${finalMessage}\n`);
    } else {
      process.stderr.write(`  ${stripAnsi(icon)} ${stripAnsi(finalMessage)}\n`);
    }
  }

  // Initial render
  if (isTTY) {
    render();
  } else {
    if (initialMessage) {
      process.stderr.write(`  [0/${total}] ${initialMessage}\n`);
    }
  }

  return {
    get current() {
      return currentVal;
    },

    get total() {
      return total;
    },

    update(current: number, message?: string): void {
      currentVal = Math.min(total, Math.max(0, current));
      if (message !== undefined) currentMessage = message;
      render();
    },

    increment(amount: number = 1, message?: string): void {
      currentVal = Math.min(total, currentVal + amount);
      if (message !== undefined) currentMessage = message;
      render();
    },

    complete(message?: string): void {
      currentVal = total;
      finalize(
        bold(green(CHECK_MARK)),
        message ?? `Complete (${total} items)`
      );
    },

    fail(message?: string): void {
      finalize(
        bold(red(CROSS_MARK)),
        message ?? `Failed at ${currentVal}/${total}`
      );
    },
  };
}

// ── Table Renderer ──────────────────────────────────────────────────────────

export interface TableColumn {
  /** Header label for the column. */
  header: string;
  /** Key in the data object to pull the value from. */
  key: string;
  /** Fixed width (if omitted, auto-sized to content). */
  width?: number;
  /** Alignment within the column (default "left"). */
  align?: "left" | "right" | "center";
  /** Optional style function to apply to cell values. */
  style?: (value: string) => string;
}

/**
 * Render a simple ASCII table to stdout.
 *
 * @param columns - Column definitions.
 * @param rows - Array of data objects.
 */
export function table(columns: TableColumn[], rows: Record<string, string>[]): void {
  if (currentLevel < LOG_LEVEL.INFO) return;

  // Calculate column widths
  const widths: number[] = columns.map((col) => {
    if (col.width) return col.width;
    let max = visibleLength(col.header);
    for (const row of rows) {
      const val = row[col.key] ?? "";
      const len = visibleLength(val);
      if (len > max) max = len;
    }
    return max;
  });

  // Helper to align text within a cell
  function alignCell(text: string, colWidth: number, alignment: "left" | "right" | "center"): string {
    const vLen = visibleLength(text);
    const padding = Math.max(0, colWidth - vLen);
    switch (alignment) {
      case "right":
        return " ".repeat(padding) + text;
      case "center": {
        const left = Math.floor(padding / 2);
        const right = padding - left;
        return " ".repeat(left) + text + " ".repeat(right);
      }
      default:
        return text + " ".repeat(padding);
    }
  }

  const sep = "  ";

  // Header row
  const headerParts = columns.map((col, i) =>
    bold(white(alignCell(col.header, widths[i]!, col.align ?? "left")))
  );
  rawLine("  " + headerParts.join(sep));

  // Header underline
  const underlineParts = widths.map((w) => dim(gray("─".repeat(w))));
  rawLine("  " + underlineParts.join(sep));

  // Data rows
  for (const row of rows) {
    const cellParts = columns.map((col, i) => {
      let val = row[col.key] ?? "";
      if (col.style) val = col.style(val);
      return alignCell(val, widths[i]!, col.align ?? "left");
    });
    rawLine("  " + cellParts.join(sep));
  }
}

// ── Timer Utility ───────────────────────────────────────────────────────────

export interface Timer {
  /** Stop the timer and return elapsed milliseconds. */
  stop(): number;
  /** Get elapsed milliseconds without stopping. */
  elapsed(): number;
  /** Get a human-readable elapsed time string. */
  format(): string;
}

/**
 * Create a simple timer for measuring operation durations.
 */
export function createTimer(): Timer {
  const start = performance.now();
  let endTime: number | null = null;

  function getElapsed(): number {
    return (endTime ?? performance.now()) - start;
  }

  function formatMs(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = ((ms % 60_000) / 1000).toFixed(1);
    return `${minutes}m ${seconds}s`;
  }

  return {
    stop(): number {
      if (endTime === null) endTime = performance.now();
      return getElapsed();
    },
    elapsed(): number {
      return getElapsed();
    },
    format(): string {
      return formatMs(getElapsed());
    },
  };
}

// ── Grouped / Contextual Logging ────────────────────────────────────────────

/**
 * Create a child logger with a specific prefix/context label.
 * Useful for module-specific logging (e.g., "[scanner]", "[provider]").
 */
export function createChildLogger(context: string) {
  const ctxLabel = dim(gray(`[${context}]`));

  return {
    debug(...args: unknown[]): void {
      if (currentLevel < LOG_LEVEL.DEBUG) return;
      const badge = dim(gray(`${BULLET_POINT} DEBUG`));
      write(process.stderr, badge, ctxLabel, ...args);
    },

    trace(...args: unknown[]): void {
      if (currentLevel < LOG_LEVEL.TRACE) return;
      const badge = dim(gray(`  TRACE`));
      write(process.stderr, badge, ctxLabel, ...args);
    },

    info(...args: unknown[]): void {
      if (currentLevel < LOG_LEVEL.INFO) return;
      const badge = bold(cyan(INFO_MARK));
      write(process.stdout, badge, ctxLabel, ...args);
    },

    success(...args: unknown[]): void {
      if (currentLevel < LOG_LEVEL.SUCCESS) return;
      const badge = bold(green(CHECK_MARK));
      write(process.stdout, badge, ctxLabel, ...args);
    },

    warn(...args: unknown[]): void {
      if (currentLevel < LOG_LEVEL.WARN) return;
      const badge = bold(yellow(WARNING_MARK));
      write(process.stderr, badge, ctxLabel, ...args);
    },

    error(...args: unknown[]): void {
      if (currentLevel < LOG_LEVEL.ERROR) return;
      const badge = bold(red(CROSS_MARK));
      write(process.stderr, badge, ctxLabel, ...args);
    },
  };
}

// ── Default Export ───────────────────────────────────────────────────────────

const logger = {
  // Core levels
  debug,
  trace,
  info,
  success,
  warn,
  error,

  // Raw output
  raw,
  rawLine,
  blank,

  // Structured output
  kvLog,
  section,
  divider,
  list,
  numberedList,
  table,

  // Utilities
  createSpinner,
  createProgressBar,
  createTimer,
  createChildLogger,

  // Configuration
  setLogLevel,
  getLogLevel,
  parseLogLevel,
  setLogTimestamps,
  setLogPrefix,

  // Constants
  LOG_LEVEL,
};

export default logger;
