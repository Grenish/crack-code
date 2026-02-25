// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — ANSI Color & Styling Utilities (Zero Dependencies)
// ─────────────────────────────────────────────────────────────────────────────
// Uses raw ANSI escape sequences for terminal styling. No external libraries.
// Supports automatic detection of color capability and graceful degradation.
// ─────────────────────────────────────────────────────────────────────────────

// ── Environment Detection ───────────────────────────────────────────────────

const env = process.env;

/**
 * Determines whether the current terminal supports ANSI color output.
 * Respects NO_COLOR (https://no-color.org/), FORCE_COLOR, and CI environments.
 */
function detectColorSupport(): boolean {
  // NO_COLOR spec — any value disables color
  if ("NO_COLOR" in env) return false;

  // FORCE_COLOR overrides everything
  if ("FORCE_COLOR" in env) {
    const val = env["FORCE_COLOR"];
    return val !== "0" && val !== "false";
  }

  // Dumb terminals don't support escape codes
  if (env["TERM"] === "dumb") return false;

  // Check if stdout is a TTY
  if (typeof process.stdout?.isTTY === "boolean") {
    return process.stdout.isTTY;
  }

  // CI environments generally support color
  if (env["CI"]) return true;

  // Default: no color if we can't determine
  return false;
}

/** Whether color output is enabled for this session */
let colorEnabled = detectColorSupport();

/** Manually enable or disable color output */
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

/** Check if color output is currently enabled */
export function isColorEnabled(): boolean {
  return colorEnabled;
}

// ── ANSI Escape Code Primitives ─────────────────────────────────────────────

const ESC = "\x1b[";
const RESET_CODE = `${ESC}0m`;

/**
 * Wraps text in an ANSI escape code pair. Returns plain text when color
 * is disabled to ensure clean output in non-TTY environments.
 */
function wrap(open: string, close: string, text: string): string {
  if (!colorEnabled) return text;

  // Handle nested resets: if the text already contains a reset code,
  // re-apply the open code after each internal reset so nesting works.
  if (text.includes(RESET_CODE)) {
    text = text.replaceAll(RESET_CODE, `${RESET_CODE}${open}`);
  }

  return `${open}${text}${close}`;
}

// ── Modifier Styles ─────────────────────────────────────────────────────────

export function bold(text: string): string {
  return wrap(`${ESC}1m`, `${ESC}22m`, text);
}

export function dim(text: string): string {
  return wrap(`${ESC}2m`, `${ESC}22m`, text);
}

export function italic(text: string): string {
  return wrap(`${ESC}3m`, `${ESC}23m`, text);
}

export function underline(text: string): string {
  return wrap(`${ESC}4m`, `${ESC}24m`, text);
}

export function inverse(text: string): string {
  return wrap(`${ESC}7m`, `${ESC}27m`, text);
}

export function hidden(text: string): string {
  return wrap(`${ESC}8m`, `${ESC}28m`, text);
}

export function strikethrough(text: string): string {
  return wrap(`${ESC}9m`, `${ESC}29m`, text);
}

// ── Foreground Colors (Standard) ────────────────────────────────────────────

export function black(text: string): string {
  return wrap(`${ESC}30m`, RESET_CODE, text);
}

export function red(text: string): string {
  return wrap(`${ESC}31m`, RESET_CODE, text);
}

export function green(text: string): string {
  return wrap(`${ESC}32m`, RESET_CODE, text);
}

export function yellow(text: string): string {
  return wrap(`${ESC}33m`, RESET_CODE, text);
}

export function blue(text: string): string {
  return wrap(`${ESC}34m`, RESET_CODE, text);
}

export function magenta(text: string): string {
  return wrap(`${ESC}35m`, RESET_CODE, text);
}

export function cyan(text: string): string {
  return wrap(`${ESC}36m`, RESET_CODE, text);
}

export function white(text: string): string {
  return wrap(`${ESC}37m`, RESET_CODE, text);
}

export function gray(text: string): string {
  return wrap(`${ESC}90m`, RESET_CODE, text);
}

// ── Foreground Colors (Bright) ──────────────────────────────────────────────

export function brightRed(text: string): string {
  return wrap(`${ESC}91m`, RESET_CODE, text);
}

export function brightGreen(text: string): string {
  return wrap(`${ESC}92m`, RESET_CODE, text);
}

export function brightYellow(text: string): string {
  return wrap(`${ESC}93m`, RESET_CODE, text);
}

export function brightBlue(text: string): string {
  return wrap(`${ESC}94m`, RESET_CODE, text);
}

export function brightMagenta(text: string): string {
  return wrap(`${ESC}95m`, RESET_CODE, text);
}

export function brightCyan(text: string): string {
  return wrap(`${ESC}96m`, RESET_CODE, text);
}

export function brightWhite(text: string): string {
  return wrap(`${ESC}97m`, RESET_CODE, text);
}

// ── Background Colors (Standard) ───────────────────────────────────────────

export function bgBlack(text: string): string {
  return wrap(`${ESC}40m`, `${ESC}49m`, text);
}

export function bgRed(text: string): string {
  return wrap(`${ESC}41m`, `${ESC}49m`, text);
}

export function bgGreen(text: string): string {
  return wrap(`${ESC}42m`, `${ESC}49m`, text);
}

export function bgYellow(text: string): string {
  return wrap(`${ESC}43m`, `${ESC}49m`, text);
}

export function bgBlue(text: string): string {
  return wrap(`${ESC}44m`, `${ESC}49m`, text);
}

export function bgMagenta(text: string): string {
  return wrap(`${ESC}45m`, `${ESC}49m`, text);
}

export function bgCyan(text: string): string {
  return wrap(`${ESC}46m`, `${ESC}49m`, text);
}

export function bgWhite(text: string): string {
  return wrap(`${ESC}47m`, `${ESC}49m`, text);
}

// ── Background Colors (Bright) ──────────────────────────────────────────────

export function bgBrightRed(text: string): string {
  return wrap(`${ESC}101m`, `${ESC}49m`, text);
}

export function bgBrightGreen(text: string): string {
  return wrap(`${ESC}102m`, `${ESC}49m`, text);
}

export function bgBrightYellow(text: string): string {
  return wrap(`${ESC}103m`, `${ESC}49m`, text);
}

export function bgBrightBlue(text: string): string {
  return wrap(`${ESC}104m`, `${ESC}49m`, text);
}

// ── 256-Color & RGB Support ─────────────────────────────────────────────────

/**
 * Apply a 256-color foreground. Color values 0–255.
 * See: https://en.wikipedia.org/wiki/ANSI_escape_code#8-bit
 */
export function fg256(color: number, text: string): string {
  const c = Math.max(0, Math.min(255, Math.round(color)));
  return wrap(`${ESC}38;5;${c}m`, RESET_CODE, text);
}

/**
 * Apply a 256-color background. Color values 0–255.
 */
export function bg256(color: number, text: string): string {
  const c = Math.max(0, Math.min(255, Math.round(color)));
  return wrap(`${ESC}48;5;${c}m`, `${ESC}49m`, text);
}

/**
 * Apply a 24-bit true color foreground (RGB).
 */
export function fgRgb(r: number, g: number, b: number, text: string): string {
  const cr = Math.max(0, Math.min(255, Math.round(r)));
  const cg = Math.max(0, Math.min(255, Math.round(g)));
  const cb = Math.max(0, Math.min(255, Math.round(b)));
  return wrap(`${ESC}38;2;${cr};${cg};${cb}m`, RESET_CODE, text);
}

/**
 * Apply a 24-bit true color background (RGB).
 */
export function bgRgb(r: number, g: number, b: number, text: string): string {
  const cr = Math.max(0, Math.min(255, Math.round(r)));
  const cg = Math.max(0, Math.min(255, Math.round(g)));
  const cb = Math.max(0, Math.min(255, Math.round(b)));
  return wrap(`${ESC}48;2;${cr};${cg};${cb}m`, `${ESC}49m`, text);
}

/**
 * Parse a hex color string (#RRGGBB or #RGB) and apply as foreground.
 */
export function fgHex(hex: string, text: string): string {
  const { r, g, b } = parseHex(hex);
  return fgRgb(r, g, b, text);
}

/**
 * Parse a hex color string (#RRGGBB or #RGB) and apply as background.
 */
export function bgHex(hex: string, text: string): string {
  const { r, g, b } = parseHex(hex);
  return bgRgb(r, g, b, text);
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace(/^#/, "");
  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0]! + cleaned[0]!, 16);
    const g = parseInt(cleaned[1]! + cleaned[1]!, 16);
    const b = parseInt(cleaned[2]! + cleaned[2]!, 16);
    return { r, g, b };
  }
  if (cleaned.length === 6) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    return { r, g, b };
  }
  return { r: 255, g: 255, b: 255 };
}

// ── Reset ───────────────────────────────────────────────────────────────────

/** Full ANSI reset — clears all styles and colors */
export function reset(text: string): string {
  if (!colorEnabled) return text;
  return `${RESET_CODE}${text}${RESET_CODE}`;
}

/** Returns the raw ANSI reset escape sequence */
export const RESET = RESET_CODE;

// ── Semantic / Application-Level Styles ─────────────────────────────────────
// These are higher-level style functions specific to Crack Code's TUI.

/** Style for success messages */
export function success(text: string): string {
  return bold(green(text));
}

/** Style for error messages */
export function error(text: string): string {
  return bold(red(text));
}

/** Style for warning messages */
export function warning(text: string): string {
  return bold(yellow(text));
}

/** Style for informational messages */
export function info(text: string): string {
  return bold(cyan(text));
}

/** Style for hints and subtle text */
export function hint(text: string): string {
  return dim(gray(text));
}

/** Style for labels/headings */
export function label(text: string): string {
  return bold(white(text));
}

/** Style for values displayed alongside labels */
export function value(text: string): string {
  return cyan(text);
}

/** Style for file paths */
export function filePath(text: string): string {
  return underline(blue(text));
}

/** Style for commands and code references */
export function code(text: string): string {
  return bold(yellow(text));
}

/** Style for the app brand name */
export function brand(text: string): string {
  return bold(brightCyan(text));
}

/** Style for severity levels */
export function severity(level: string): string {
  const lower = level.toLowerCase();
  switch (lower) {
    case "critical":
      return bold(bgRed(white(` ${level.toUpperCase()} `)));
    case "high":
      return bold(red(level.toUpperCase()));
    case "medium":
      return bold(yellow(level.toUpperCase()));
    case "low":
      return bold(blue(level.toUpperCase()));
    case "info":
      return bold(gray(level.toUpperCase()));
    default:
      return bold(white(level.toUpperCase()));
  }
}

/** Style for vulnerability category tags */
export function tag(text: string): string {
  return dim(magenta(`[${text}]`));
}

/** Style for numbering / bullet points */
export function bullet(n: number | string): string {
  return dim(yellow(`${n}.`));
}

/** Style for horizontal rule / separator */
export function separator(width: number = 70): string {
  return dim(gray("─".repeat(width)));
}

/** Style for section headers */
export function sectionHeader(text: string): string {
  const line = "─".repeat(Math.max(0, 70 - text.length - 4));
  return `${dim(gray("── "))}${bold(brightCyan(text))}${dim(gray(` ${line}`))}`;
}

/** Style for the input prompt caret */
export function promptCaret(): string {
  return bold(brightGreen("\uf054 ")); //  nf-fa-chevron_right
}

/** Style for key-value pair display (e.g., "  Key: Value") */
export function kvPair(
  key: string,
  val: string,
  keyWidth: number = 16,
): string {
  const paddedKey = key.padEnd(keyWidth);
  return `  ${label(paddedKey)} ${value(val)}`;
}

// ── Cursor & Screen Control ─────────────────────────────────────────────────

/** Move cursor up N lines */
export function cursorUp(n: number = 1): string {
  return `${ESC}${n}A`;
}

/** Move cursor down N lines */
export function cursorDown(n: number = 1): string {
  return `${ESC}${n}B`;
}

/** Move cursor right N columns */
export function cursorRight(n: number = 1): string {
  return `${ESC}${n}C`;
}

/** Move cursor left N columns */
export function cursorLeft(n: number = 1): string {
  return `${ESC}${n}D`;
}

/** Move cursor to column N */
export function cursorTo(col: number): string {
  return `${ESC}${col}G`;
}

/** Hide the cursor */
export function cursorHide(): string {
  return `${ESC}?25l`;
}

/** Show the cursor */
export function cursorShow(): string {
  return `${ESC}?25h`;
}

/** Save cursor position */
export function cursorSave(): string {
  return `${ESC}s`;
}

/** Restore cursor position */
export function cursorRestore(): string {
  return `${ESC}u`;
}

/** Clear the entire screen */
export function clearScreen(): string {
  return `${ESC}2J${ESC}H`;
}

/** Clear from cursor to end of screen */
export function clearDown(): string {
  return `${ESC}J`;
}

/** Clear from cursor to end of line */
export function clearLine(): string {
  return `${ESC}K`;
}

/** Clear the entire current line */
export function clearEntireLine(): string {
  return `${ESC}2K`;
}

// ── String Measurement ──────────────────────────────────────────────────────

/** Strip all ANSI escape codes from a string to get its visible length */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** Get the visible character length of a string (ignoring ANSI codes) */
export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

/**
 * Pad a styled string to a target visible width.
 * Accounts for invisible ANSI escape code characters.
 */
export function padStyled(
  text: string,
  targetWidth: number,
  padChar: string = " ",
): string {
  const visible = visibleLength(text);
  if (visible >= targetWidth) return text;
  return text + padChar.repeat(targetWidth - visible);
}

/**
 * Center a styled string within a target width.
 */
export function centerStyled(
  text: string,
  targetWidth: number,
  padChar: string = " ",
): string {
  const visible = visibleLength(text);
  if (visible >= targetWidth) return text;
  const totalPad = targetWidth - visible;
  const leftPad = Math.floor(totalPad / 2);
  const rightPad = totalPad - leftPad;
  return padChar.repeat(leftPad) + text + padChar.repeat(rightPad);
}

// ── Box Drawing ─────────────────────────────────────────────────────────────

export interface BoxOptions {
  title?: string;
  padding?: number;
  borderColor?: (text: string) => string;
  width?: number;
}

/**
 * Draw a Unicode box around content lines.
 */
export function box(lines: string[], options: BoxOptions = {}): string {
  const {
    title,
    padding = 1,
    borderColor = dim,
    width: explicitWidth,
  } = options;

  const pad = " ".repeat(padding);

  // Calculate the inner width based on visible content
  let innerWidth = 0;
  for (const line of lines) {
    const len = visibleLength(line);
    if (len > innerWidth) innerWidth = len;
  }

  if (title) {
    const titleLen = visibleLength(title);
    if (titleLen + 4 > innerWidth) innerWidth = titleLen + 4;
  }

  if (explicitWidth && explicitWidth > innerWidth + padding * 2 + 2) {
    innerWidth = explicitWidth - padding * 2 - 2;
  }

  const totalInner = innerWidth + padding * 2;

  // Build the box
  const output: string[] = [];

  // Top border
  if (title) {
    const titleStr = ` ${title} `;
    const titleLen = visibleLength(titleStr);
    const remaining = totalInner - titleLen - 1;
    output.push(
      borderColor("╭─") +
        bold(brightCyan(titleStr)) +
        borderColor("─".repeat(Math.max(0, remaining)) + "╮"),
    );
  } else {
    output.push(borderColor("╭" + "─".repeat(totalInner) + "╮"));
  }

  // Content lines
  for (const line of lines) {
    const visible = visibleLength(line);
    const rightPad = " ".repeat(Math.max(0, innerWidth - visible));
    output.push(
      borderColor("│") + pad + line + rightPad + pad + borderColor("│"),
    );
  }

  // Bottom border
  output.push(borderColor("╰" + "─".repeat(totalInner) + "╯"));

  return output.join("\n");
}

// ── Spinner Characters ──────────────────────────────────────────────────────

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

// ── Nerd Font Icons ─────────────────────────────────────────────────────────
// All icons below use Nerd Font glyphs (Private Use Area).
// Requires a Nerd Font patched terminal font to render correctly.
// Reference: https://www.nerdfonts.com/cheat-sheet

export const CHECK_MARK = "\uf00c"; //  nf-fa-check
export const CROSS_MARK = "\uf00d"; //  nf-fa-times
export const WARNING_MARK = "\uf071"; //  nf-fa-warning
export const INFO_MARK = "\uf05a"; //  nf-fa-info_circle
export const ARROW_RIGHT = "\uf061"; //  nf-fa-arrow_right
export const ARROW_DOWN = "\uf063"; //  nf-fa-arrow_down
export const BULLET_POINT = "\uf111"; //  nf-fa-circle
export const ELLIPSIS = "…";
export const LOCK_ICON = "\uf023"; //  nf-fa-lock
export const KEY_ICON = "\uf084"; //  nf-fa-key
export const SHIELD_ICON = "\uf132"; //  nf-fa-shield
export const BUG_ICON = "\uf188"; //  nf-fa-bug
export const FOLDER_ICON = "\uf07b"; //  nf-fa-folder
export const FILE_ICON = "\uf016"; //  nf-fa-file_o
export const SEARCH_ICON = "\uf002"; //  nf-fa-search
export const GEAR_ICON = "\uf013"; //  nf-fa-cog
export const ROCKET_ICON = "\uf135"; //  nf-fa-rocket
export const CHEVRON_RIGHT = "\uf054"; //  nf-fa-chevron_right
