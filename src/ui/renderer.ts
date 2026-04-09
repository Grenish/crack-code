import { CrackCodeLogo } from "../logo/crack-code.js";
import { createRequire } from "node:module";
import { APP_VERSION } from "../version.js";

// ─── ANSI Color Palette ─────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  under: "\x1b[4m",
  strike: "\x1b[9m",

  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
  bgGray: "\x1b[100m",
} as const;

const MAX_SURFACE_WIDTH = 118;

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

const SEVERITY_STYLE: Record<Severity, { badge: string; color: string }> = {
  CRITICAL: {
    badge: `${C.bold}${C.bgRed}${C.white} CRITICAL ${C.reset}`,
    color: C.red,
  },
  HIGH: {
    badge: `${C.bold}${C.bgYellow}${C.white} HIGH ${C.reset}`,
    color: C.yellow,
  },
  MEDIUM: {
    badge: `${C.bold}${C.bgCyan}${C.white} MEDIUM ${C.reset}`,
    color: C.cyan,
  },
  LOW: {
    badge: `${C.bold}${C.bgGray}${C.white} LOW ${C.reset}`,
    color: C.gray,
  },
  INFO: { badge: `${C.dim} INFO ${C.reset}`, color: C.gray },
};

let activeSpinner: SpinnerHandle | null = null;
const require = createRequire(import.meta.url);

// Optional syntax highlighting hook. If cli-highlight is unavailable,
// code blocks still render with plain ANSI styling.
let cliHighlight:
  | ((
      code: string,
      options?: { language?: string; ignoreIllegals?: boolean },
    ) => string)
  | null
  | undefined = undefined;

// ─── Streaming Markdown State ───────────────────────────────────────

// Code fence state
let inCodeBlock = false;
let codeFenceLang = "";
let codeFenceOpening = false; // true while collecting language after opening ```
let codeLineBuffer = "";

// Line-level state
let lineBuffer = "";
let atLineStart = true; // true when we're at col 0 of a new line

// Inline state — tracks pending marker characters for bold/italic/code
let pendingBackticks = 0;

function getCliHighlight():
  | ((
      code: string,
      options?: { language?: string; ignoreIllegals?: boolean },
    ) => string)
  | null {
  if (cliHighlight !== undefined) return cliHighlight;

  try {
    const mod = require("cli-highlight") as {
      highlight?: (
        code: string,
        options?: { language?: string; ignoreIllegals?: boolean },
      ) => string;
      default?:
        | ((
            code: string,
            options?: { language?: string; ignoreIllegals?: boolean },
          ) => string)
        | {
            highlight?: (
              code: string,
              options?: { language?: string; ignoreIllegals?: boolean },
            ) => string;
          };
    };

    const candidate =
      mod.highlight ??
      (typeof mod.default === "function"
        ? mod.default
        : mod.default?.highlight);

    cliHighlight = typeof candidate === "function" ? candidate : null;
  } catch {
    cliHighlight = null;
  }

  return cliHighlight;
}

function normalizeCodeLang(lang: string): string {
  const raw = lang.trim().toLowerCase();
  if (!raw) return "";

  const aliases: Record<string, string> = {
    cjs: "javascript",
    js: "javascript",
    mjs: "javascript",
    sh: "bash",
    ts: "typescript",
    yml: "yaml",
  };

  return aliases[raw] ?? raw;
}

function isDiffLang(lang: string): boolean {
  const normalized = normalizeCodeLang(lang);
  return normalized === "diff" || normalized === "patch";
}

function formatDiffLine(line: string): string {
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode")
  ) {
    return `${C.dim}${line}${C.reset}`;
  }

  if (line.startsWith("+++ ") || line.startsWith("--- ")) {
    return `${C.bold}${C.magenta}${line}${C.reset}`;
  }

  if (line.startsWith("@@")) {
    return `${C.bold}${C.cyan}${line}${C.reset}`;
  }

  if (line.startsWith("+")) {
    return `${C.green}${line}${C.reset}`;
  }

  if (line.startsWith("-")) {
    return `${C.red}${line}${C.reset}`;
  }

  return `${C.white}${line}${C.reset}`;
}

function formatCodeLine(line: string, lang: string): string {
  if (line.length === 0) return "";

  const normalizedLang = normalizeCodeLang(lang);
  if (isDiffLang(normalizedLang)) {
    return formatDiffLine(line);
  }

  const highlight = getCliHighlight();
  if (highlight && normalizedLang) {
    try {
      return highlight(line, {
        ignoreIllegals: true,
        language: normalizedLang,
      });
    } catch {
      // fall back below
    }
  }

  return `${C.white}${line}${C.reset}`;
}

function emitCodeLine(rawLine: string): void {
  const rendered = formatCodeLine(rawLine, codeFenceLang);
  process.stdout.write(`${rendered}\n`);
}

// ─── Streaming Markdown Renderer ────────────────────────────────────
//
// Design: We accumulate text character-by-character. When we're inside
// a code fence we emit raw cyan text. Outside code fences we buffer
// each line and, at newline boundaries, apply:
//   1. Block-level decoration  (headings, lists, blockquotes, HRs)
//   2. Inline formatting       (bold, italic, inline code, strikethrough)
//
// This gives us the best fidelity we can get while keeping the streaming
// feel — block decorations appear as soon as the newline arrives, and
// inline formatting is applied per-line.

export function streamReasoning(chunk: string): void {
  if (activeSpinner) activeSpinner.stop();
  process.stdout.write(`${C.dim}${C.italic}${chunk}${C.reset}`);
}

export function streamText(chunk: string): void {
  if (activeSpinner) activeSpinner.stop();

  for (let i = 0; i < chunk.length; i++) {
    const char = chunk[i]!;

    // ── Code fence detection ─────────────────────────────
    if (char === "`") {
      pendingBackticks++;

      // Once we hit 3 backticks, toggle code block mode
      if (pendingBackticks === 3) {
        pendingBackticks = 0;

        if (!inCodeBlock) {
          // Opening fence — start collecting the language tag
          inCodeBlock = true;
          codeFenceLang = "";
          codeLineBuffer = "";
          codeFenceOpening = true;
          // Flush any buffered line content before the fence
          if (lineBuffer.length > 0) {
            emitFormattedLine(lineBuffer);
            lineBuffer = "";
          }
        } else {
          // Closing fence
          if (codeLineBuffer.length > 0) {
            emitCodeLine(codeLineBuffer);
            codeLineBuffer = "";
          }
          inCodeBlock = false;
          codeFenceOpening = false;
          process.stdout.write("\n");
          atLineStart = true;
          lineBuffer = "";
        }
      }
      continue;
    }

    // If we had 1 or 2 pending backticks that didn't become 3, flush them
    if (pendingBackticks > 0) {
      const ticks = "`".repeat(pendingBackticks);
      pendingBackticks = 0;

      if (inCodeBlock) {
        process.stdout.write(ticks);
      } else {
        lineBuffer += ticks;
        atLineStart = false;
      }
    }

    // ── Inside a code fence ──────────────────────────────
    if (inCodeBlock) {
      if (codeFenceOpening) {
        // Still on the opening line — collect language tag until newline
        if (char === "\n") {
          codeFenceOpening = false;
          process.stdout.write("\n");
          atLineStart = true;
        } else {
          codeFenceLang += char;
        }
        continue;
      }

      // Normal code content
      if (char === "\n") {
        emitCodeLine(codeLineBuffer);
        codeLineBuffer = "";
        atLineStart = true;
      } else {
        codeLineBuffer += char;
        atLineStart = false;
      }
      continue;
    }

    // ── Outside code fences — buffer until newline ───────
    if (char === "\n") {
      emitFormattedLine(lineBuffer);
      lineBuffer = "";
      atLineStart = true;
    } else {
      lineBuffer += char;
      atLineStart = false;
    }
  }
}

// ─── Line-Level Formatting ──────────────────────────────────────────

function emitFormattedLine(raw: string): void {
  const trimmed = raw.trimStart();
  const indent = raw.length - trimmed.length;
  const pad = " ".repeat(indent);

  // ── Horizontal rule ──
  if (/^[-*_]{3,}\s*$/.test(trimmed)) {
    process.stdout.write(`\n${C.gray}  ${"─".repeat(50)}${C.reset}\n`);
    return;
  }

  // ── Headings ──
  const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)/);
  if (headingMatch) {
    const level = headingMatch[1]!.length;
    const text = headingMatch[2]!;
    const formatted = applyInlineFormatting(text);

    if (level === 1) {
      process.stdout.write(
        `\n${pad}${C.bold}${C.magenta}█ ${formatted}${C.reset}\n`,
      );
    } else if (level === 2) {
      process.stdout.write(
        `\n${pad}${C.bold}${C.blue}■ ${formatted}${C.reset}\n`,
      );
    } else if (level === 3) {
      process.stdout.write(
        `\n${pad}${C.bold}${C.cyan}▸ ${formatted}${C.reset}\n`,
      );
    } else {
      process.stdout.write(
        `\n${pad}${C.bold}${C.white}${"▸".repeat(level - 2)} ${formatted}${C.reset}\n`,
      );
    }
    return;
  }

  // ── Blockquote ──
  const blockquoteMatch = trimmed.match(/^>\s?(.*)/);
  if (blockquoteMatch) {
    const text = blockquoteMatch[1]!;
    const formatted = applyInlineFormatting(text);
    process.stdout.write(
      `${pad}${C.gray}  ┃${C.reset} ${C.italic}${C.white}${formatted}${C.reset}\n`,
    );
    return;
  }

  // ── Checkbox (task list) — must come before unordered list ──
  const checkMatch = trimmed.match(/^[-*+]\s+\[([ xX])\]\s+(.*)/);
  if (checkMatch) {
    const checked = checkMatch[1] !== " ";
    const text = checkMatch[2]!;
    const formatted = applyInlineFormatting(text);
    const box = checked ? `${C.green}☑${C.reset}` : `${C.gray}☐${C.reset}`;
    process.stdout.write(`${pad}  ${box} ${formatted}${C.reset}\n`);
    return;
  }

  // ── Unordered list ──
  const ulMatch = trimmed.match(/^[-*+]\s+(.*)/);
  if (ulMatch) {
    const text = ulMatch[1]!;
    const formatted = applyInlineFormatting(text);
    process.stdout.write(
      `${pad}  ${C.cyan}•${C.reset} ${formatted}${C.reset}\n`,
    );
    return;
  }

  // ── Ordered list ──
  const olMatch = trimmed.match(/^(\d+)[.)]\s+(.*)/);
  if (olMatch) {
    const num = olMatch[1]!;
    const text = olMatch[2]!;
    const formatted = applyInlineFormatting(text);
    process.stdout.write(
      `${pad}  ${C.cyan}${num}.${C.reset} ${formatted}${C.reset}\n`,
    );
    return;
  }

  // ── Normal paragraph line ──
  const formatted = applyInlineFormatting(raw);
  process.stdout.write(`${formatted}${C.reset}\n`);
}

// ─── Inline Formatting ──────────────────────────────────────────────
//
// Applies bold, italic, inline code, and strikethrough to a single
// line of text. Works by scanning through the string and matching
// Markdown markers. We process in priority order:
//   1. Inline code (backticks)  — highest priority, no nesting
//   2. Bold + italic (***…***)
//   3. Bold (**…**)
//   4. Italic (*…* or _…_)
//   5. Strikethrough (~~…~~)

function applyInlineFormatting(text: string): string {
  // Pass 1: Protect inline code spans (no formatting inside them)
  const codeSpans: string[] = [];
  let processed = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    const idx = codeSpans.length;
    codeSpans.push(code);
    return `\x00CODE${idx}\x00`;
  });

  // Pass 2: Bold + italic
  processed = processed.replace(
    /\*\*\*(.+?)\*\*\*/g,
    `${C.bold}${C.italic}${C.white}$1${C.reset}`,
  );

  // Pass 3: Bold
  processed = processed.replace(
    /\*\*(.+?)\*\*/g,
    `${C.bold}${C.white}$1${C.reset}`,
  );
  processed = processed.replace(
    /__(.+?)__/g,
    `${C.bold}${C.white}$1${C.reset}`,
  );

  // Pass 4: Italic
  processed = processed.replace(
    /\*(.+?)\*/g,
    `${C.italic}${C.white}$1${C.reset}`,
  );
  processed = processed.replace(
    /_(.+?)_/g,
    `${C.italic}${C.white}$1${C.reset}`,
  );

  // Pass 5: Strikethrough
  processed = processed.replace(
    /~~(.+?)~~/g,
    `${C.dim}${C.strike}$1${C.reset}`,
  );

  // Pass 6: Links [text](url) — show text in underline, URL dimmed
  processed = processed.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    `${C.under}${C.cyan}$1${C.reset}${C.gray} ($2)${C.reset}`,
  );

  // Restore inline code spans
  processed = processed.replace(/\x00CODE(\d+)\x00/g, (_match, idx: string) => {
    const code = codeSpans[parseInt(idx, 10)] ?? "";
    return `${C.bgGray}${C.white} ${code} ${C.reset}`;
  });

  return processed;
}

// ─── Lifecycle ──────────────────────────────────────────────────────

export function resetStreamState(): void {
  inCodeBlock = false;
  codeFenceLang = "";
  codeFenceOpening = false;
  codeLineBuffer = "";
  lineBuffer = "";
  atLineStart = true;
  pendingBackticks = 0;
}

export function flushStream(): void {
  // Flush any remaining pending ticks
  if (pendingBackticks > 0) {
    if (inCodeBlock) {
      process.stdout.write("`".repeat(pendingBackticks));
    } else {
      lineBuffer += "`".repeat(pendingBackticks);
    }
    pendingBackticks = 0;
  }

  // Flush remaining line buffer
  if (lineBuffer.length > 0 && !inCodeBlock) {
    emitFormattedLine(lineBuffer);
    lineBuffer = "";
  }

  if (inCodeBlock && codeLineBuffer.length > 0) {
    emitCodeLine(codeLineBuffer);
    codeLineBuffer = "";
  }

  // If we're stuck inside a code block (malformed markdown), close it
  if (inCodeBlock) {
    process.stdout.write("\n");
    inCodeBlock = false;
  }

  atLineStart = true;
}

export function newline(): void {
  if (activeSpinner) activeSpinner.stop();
  flushStream();
  process.stdout.write("\n");
  resetStreamState();
}

export function clearLine(): void {
  if (activeSpinner) activeSpinner.stop();
  process.stdout.write("\r\x1b[K");
}

// ─── Layout Helpers ─────────────────────────────────────────────────

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

function termWidth(): number {
  return Math.max(80, Math.min(process.stdout.columns || 120, 160));
}

function panelWidth(): number {
  return Math.max(
    68,
    Math.min((process.stdout.columns || 120) - 2, MAX_SURFACE_WIDTH),
  );
}

function rule(width = panelWidth()): string {
  return `${C.gray}${"─".repeat(width)}${C.reset}`;
}

function boxedSection(
  title: string,
  lines: string[],
  width = panelWidth(),
  accent: keyof typeof C = "cyan",
): string[] {
  const boxWidth = Math.max(24, width);
  const inner = Math.max(16, boxWidth - 4);
  const topPrefix = `${C.gray}╭─ ${C.reset}${C[accent]}${C.bold}${title}${C.reset}${C.gray} `;
  const topFill = "─".repeat(
    Math.max(0, boxWidth - visibleLength(topPrefix) - 1),
  );
  const out = [`${topPrefix}${topFill}╮${C.reset}`];

  for (const line of lines) {
    out.push(
      `${C.gray}│ ${C.reset}${normalizeCell(line, inner)}${C.gray} │${C.reset}`,
    );
  }

  out.push(`${C.gray}╰${"─".repeat(boxWidth - 2)}╯${C.reset}`);
  return out;
}

function joinColumns(left: string[], right: string[], gap = "  "): string[] {
  const leftWidth = Math.max(...left.map((l) => visibleLength(l)), 0);
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];

  for (let i = 0; i < rows; i++) {
    const l = left[i] ?? "";
    const r = right[i] ?? "";
    out.push(`${padVisible(l, leftWidth)}${gap}${r}`);
  }

  return out;
}

function compactPath(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return cwd;
  return `…/${parts.slice(-3).join("/")}`;
}

// ─── Tool Call UI ───────────────────────────────────────────────────

export function toolStart(name: string, args?: unknown): void {
  if (activeSpinner) activeSpinner.stop();

  const width = panelWidth();
  const summary = composeToolStartSummary(name, args);
  const line = truncateVisible(
    `${C.cyan}${C.bold}◆${C.reset} ${C.white}${name}${C.reset} ${C.dim}${summary}${C.reset}`,
    width,
  );

  process.stdout.write(`${line}\n`);
}

export function toolEnd(name: string, result: string): void {
  if (activeSpinner) activeSpinner.stop();

  const width = panelWidth();
  const lines = summarizeToolResult(name, result, Math.max(20, width - 4));

  const done = truncateVisible(
    `${C.green}${C.bold}✓${C.reset} ${C.white}${name}${C.reset} ${C.dim}completed${C.reset}`,
    width,
  );
  process.stdout.write(`${done}\n`);

  for (const line of lines) {
    process.stdout.write(`${truncateVisible(line, width)}\n`);
  }

  process.stdout.write("\n");
}

export function toolBlocked(name: string, reason: string): void {
  if (activeSpinner) activeSpinner.stop();
  process.stdout.write(`\n${C.gray}  ╭─ ${C.red}${name}${C.reset}\n`);
  process.stdout.write(
    `${C.gray}  │${C.reset} ${C.red}⛔ ${reason}${C.reset}\n`,
  );
  process.stdout.write(`${C.gray}  ╰─${C.reset}\n\n`);
}

// ─── Severity ───────────────────────────────────────────────────────

export function severity(level: string): void {
  if (activeSpinner) activeSpinner.stop();
  const key = level.toUpperCase() as Severity;
  const style = SEVERITY_STYLE[key];
  if (style) {
    process.stdout.write(`${style.badge} `);
  } else {
    process.stdout.write(`${C.dim}[${level}]${C.reset} `);
  }
}

// ─── Spinner ────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerHandle {
  update: (text: string) => void;
  stop: () => void;
}

export function spinner(text: string): SpinnerHandle {
  if (activeSpinner) activeSpinner.stop();

  let i = 0;
  let current = text;

  const id = setInterval(() => {
    const frame = SPINNER_FRAMES[i++ % SPINNER_FRAMES.length];
    process.stdout.write(
      `\r\x1b[K${C.cyan}${frame}${C.reset} ${C.gray}${current}${C.reset}`,
    );
  }, 80);

  const handle: SpinnerHandle = {
    update(newText: string) {
      current = newText;
    },
    stop() {
      clearInterval(id);
      process.stdout.write("\r\x1b[K");
      if (activeSpinner === handle) activeSpinner = null;
    },
  };

  activeSpinner = handle;
  return handle;
}

// ─── Prompts ────────────────────────────────────────────────────────

export interface PromptFrameState {
  cwd: string;
  modelLabel: string;
  input: string;
  cursor: number;
  placeholder: string;
  footerLines: string[];
  isHome?: boolean;
}

export interface PromptFrameRender {
  cursorCol: number;
  cursorRow: number;
  lines: string[];
}

function composePromptFrameTop(width: number): string {
  const innerWidth = Math.max(20, width - 4);
  return `${C.gray}╭${"─".repeat(innerWidth)}╮${C.reset}`;
}

function composePromptFrameBottom(width: number): string {
  const innerWidth = Math.max(20, width - 4);
  return `${C.gray}╰${"─".repeat(innerWidth)}╯${C.reset}`;
}

export function renderPromptFrame(state: PromptFrameState): PromptFrameRender {
  const width = panelWidth();
  const innerWidth = Math.max(20, width - 4);
  const prompt = `${C.gray}>${C.reset} `;
  const promptVisible = visibleLength(prompt);
  const inputWidth = Math.max(10, innerWidth - promptVisible - 2);
  const input = state.input;

  let displayStart = 0;
  if (input.length > inputWidth) {
    if (state.cursor <= inputWidth) {
      displayStart = 0;
    } else if (state.cursor >= input.length - 1) {
      displayStart = input.length - inputWidth;
    } else {
      displayStart = Math.max(0, state.cursor - Math.floor(inputWidth / 2));
      if (displayStart + inputWidth > input.length) {
        displayStart = input.length - inputWidth;
      }
    }
  }

  const visibleInput =
    input.length > 0
      ? input.slice(displayStart, displayStart + inputWidth)
      : state.placeholder;
  const content =
    input.length > 0
      ? visibleInput
      : `${C.dim}${truncate(state.placeholder, inputWidth)}${C.reset}`;
  const footerLines = state.footerLines.map((line) => {
    const clipped = truncateVisible(line, width);
    if (clipped.length === 0) return "";

    const trimmed = clipped.trimStart();
    if (trimmed.startsWith(">")) {
      return `${C.white}${clipped}${C.reset}`;
    }

    return `${C.gray}${clipped}${C.reset}`;
  });

  const lines = [
    composePromptFrameTop(width),
    `${C.gray}│${C.reset} ${prompt}${padVisible(content, inputWidth)} ${C.gray}│${C.reset}`,
    composePromptFrameBottom(width),
    ...footerLines,
  ];

  return {
    lines,
    cursorCol: 2 + promptVisible + Math.max(0, state.cursor - displayStart),
    cursorRow: 1,
  };
}

export function userPrompt(inputPreview = ""): void {
  if (activeSpinner) activeSpinner.stop();

  const frame = renderPromptFrame({
    cwd: process.cwd(),
    modelLabel: "model",
    input: inputPreview,
    cursor: inputPreview.length,
    placeholder: "Describe a scan target or threat to review",
    footerLines: ["/ commands • ? quick ask"],
  });
  process.stdout.write(`${frame.lines.join("\n")}\n`);
}

export function permissionPrompt(name: string, summary: string): void {
  if (activeSpinner) activeSpinner.stop();

  const lines = [
    `${C.yellow}Permission required${C.reset}`,
    `Tool   ${C.white}${name}${C.reset}`,
    summary
      ? `Action ${C.dim}${summary}${C.reset}`
      : `${C.dim}Awaiting confirmation for privileged action${C.reset}`,
    `${C.dim}Choose:${C.reset} ${C.green}y${C.reset}=yes  ${C.red}n${C.reset}=no  ${C.yellow}a${C.reset}=always for this session`,
  ];

  process.stdout.write(
    `\n${boxedSection("Approval", lines, panelWidth(), "yellow").join("\n")}\n`,
  );
}

// ─── Status Messages ───────────────────────────────────────────────

export function info(msg: string): void {
  if (activeSpinner) activeSpinner.stop();
  console.log(`${C.cyan}ℹ${C.reset} ${C.gray}${msg}${C.reset}`);
}

export function success(msg: string): void {
  if (activeSpinner) activeSpinner.stop();
  console.log(`${C.green}✓${C.reset} ${msg}`);
}

export function warn(msg: string): void {
  if (activeSpinner) activeSpinner.stop();
  console.log(`${C.yellow}⚠${C.reset} ${C.yellow}${msg}${C.reset}`);
}

export function error(msg: string): void {
  if (activeSpinner) activeSpinner.stop();
  console.error(`${C.red}✗ ${msg}${C.reset}`);
}

export function dim(msg: string): void {
  if (activeSpinner) activeSpinner.stop();
  console.log(`${C.gray}${msg}${C.reset}`);
}

// ─── Banner ─────────────────────────────────────────────────────────

export interface BannerState {
  gitBranch?: string | null;
  host: string;
  osUser: string;
  userName?: string;
}

export function banner(state: BannerState): void {
  if (activeSpinner) activeSpinner.stop();

  const width = panelWidth();
  const logoContent = CrackCodeLogo().trim();
  const logoLines = logoContent
    .split("\n")
    .map((line) => `${C.cyan}${line}${C.reset}`);

  // Build system info for right side
  const gitLabel = state.gitBranch
    ? `${C.green}yes${C.reset} ${C.white}(${state.gitBranch})${C.reset}`
    : `${C.dim}no${C.reset}`;
  // Draw banner
  console.log();

  // Logo
  for (const line of logoLines) {
    console.log(line);
  }

  console.log();

  // Title and version
  const greetingName = state.userName?.trim() || state.osUser;
  const titleLine = `${C.white}crack-code${C.reset} ${C.dim}v${APP_VERSION}${C.reset}`;
  console.log(titleLine);

  console.log();
  // Greeting
  const greeting = `${C.bold}${C.white}Hello ${greetingName}, what are we cracking today?${C.reset}`;
  console.log(greeting);

  // Help text
  const helpText = `${C.dim}/help for commands • type / to browse commands • /model and /provider to change${C.reset}`;
  console.log(helpText);

  console.log();
}

// ─── Helpers ────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function formatArgs(toolName: string, args: unknown): string {
  if (typeof args !== "object" || args === null) return "";

  const a = args as Record<string, unknown>;

  switch (toolName) {
    case "read_file":
      return String(a.path ?? "");
    case "write_file":
      return String(a.path ?? "");
    case "run_command":
      return `$ ${String(a.command ?? "")}`;
    case "list_files":
      return String(a.pattern ?? "");
    default:
      return truncate(JSON.stringify(args), 100);
  }
}

function composeToolStartSummary(name: string, args?: unknown): string {
  const summary = args ? formatArgs(name, args) : "";
  if (!summary) return "preparing";

  switch (name) {
    case "list_files":
      return `list ${truncate(summary, 80)}`;
    case "read_file":
      return `read ${truncate(summary, 80)}`;
    case "write_file":
      return `write ${truncate(summary, 80)}`;
    case "run_command":
      return `run ${truncate(summary, 80)}`;
    default:
      return truncate(summary, 80);
  }
}

function summarizeToolResult(
  name: string,
  result: string,
  width: number,
): string[] {
  const clean = result.replace(/\r/g, "");
  const lines = clean.split("\n").filter((line) => line.length > 0);

  if (lines.length === 0) {
    return [`${C.dim}no output${C.reset}`];
  }

  if (name === "list_files") {
    const header =
      lines.find((line) => /^Found\s+\d+/.test(line)) ??
      lines.find((line) => /No files matched/.test(line)) ??
      lines[0]!;
    const fileLines = lines.filter(
      (line) =>
        !/^Found\s+\d+/.test(line) &&
        !/^No files matched/.test(line) &&
        !/^Error:/.test(line),
    );
    const preview = fileLines
      .slice(0, 4)
      .map(
        (line) =>
          `${C.gray}•${C.reset} ${truncate(line, Math.max(20, width - 4))}`,
      );
    const more =
      fileLines.length > 4
        ? [`${C.dim}… ${fileLines.length - 4} more${C.reset}`]
        : [];

    return [
      `${C.white}${truncate(header, width)}${C.reset}`,
      ...preview,
      ...more,
    ];
  }

  if (name === "read_file") {
    const header = lines[0] ?? "File read complete";
    const numbered = lines.filter((line) => /^\s*\d+\s*[│|]/.test(line));
    const preview = numbered
      .slice(0, 4)
      .map((line) => `${C.gray}${truncate(line, width)}${C.reset}`);

    const headerMore = lines.find((line) => /more lines|truncated/i.test(line));
    const extra =
      headerMore ??
      (numbered.length > 4 ? `… ${numbered.length - 4} more lines` : "");

    return [
      `${C.white}${truncate(header, width)}${C.reset}`,
      ...(preview.length > 0
        ? preview
        : [`${C.dim}preview unavailable${C.reset}`]),
      ...(extra ? [`${C.dim}${truncate(extra, width)}${C.reset}`] : []),
    ];
  }

  const preview = lines.slice(0, 4).map((line) => truncate(line, width));
  const more =
    lines.length > 4 ? [`${C.dim}… ${lines.length - 4} more${C.reset}`] : [];

  return [...preview, ...more];
}
