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

// ─── Streaming Markdown State ───────────────────────────────────────

// Code fence state
let inCodeBlock = false;
let codeFenceLang = "";
let codeFenceOpening = false; // true while collecting language after opening ```

// Line-level state
let lineBuffer = "";
let atLineStart = true; // true when we're at col 0 of a new line

// Inline state — tracks pending marker characters for bold/italic/code
let pendingBackticks = 0;

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
          codeFenceOpening = true;
          // Flush any buffered line content before the fence
          if (lineBuffer.length > 0) {
            emitFormattedLine(lineBuffer);
            lineBuffer = "";
          }
        } else {
          // Closing fence
          inCodeBlock = false;
          codeFenceOpening = false;
          process.stdout.write(
            `${C.reset}\n${C.gray}  ╰${"─".repeat(48)}${C.reset}\n`,
          );
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
          const lang = codeFenceLang.trim();
          const label = lang || "code";
          process.stdout.write(
            `\n${C.gray}  ╭─ ${C.cyan}${C.bold}${label}${C.reset}${C.gray} ${"─".repeat(Math.max(0, 44 - label.length))}${C.reset}\n`,
          );
          atLineStart = true;
        } else {
          codeFenceLang += char;
        }
        continue;
      }

      // Normal code content
      if (char === "\n") {
        process.stdout.write("\n");
        atLineStart = true;
      } else {
        if (atLineStart) {
          process.stdout.write(`${C.gray}  │${C.reset} ${C.cyan}`);
          atLineStart = false;
        }
        process.stdout.write(char);
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
  if (lineBuffer.length > 0) {
    emitFormattedLine(lineBuffer);
    lineBuffer = "";
  }

  // If we're stuck inside a code block (malformed markdown), close it
  if (inCodeBlock) {
    process.stdout.write(
      `${C.reset}\n${C.gray}  ╰${"─".repeat(48)}${C.reset}\n`,
    );
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

// ─── Tool Call UI ───────────────────────────────────────────────────

export function toolStart(name: string, args?: unknown): void {
  if (activeSpinner) activeSpinner.stop();
  const summary = args ? truncate(formatArgs(name, args), 100) : "";
  process.stdout.write(
    `\n${C.gray}  ╭─ ${C.cyan}${C.bold}${name}${C.reset}${summary ? ` ${C.gray}${summary}` : ""}${C.reset}\n`,
  );
}

export function toolEnd(name: string, result: string): void {
  if (activeSpinner) activeSpinner.stop();
  const lines = result.split("\n");
  const maxPreview = 6;
  const preview = lines.slice(0, maxPreview);

  for (const line of preview) {
    process.stdout.write(`${C.gray}  │${C.reset} ${line}\n`);
  }

  if (lines.length > maxPreview) {
    process.stdout.write(
      `${C.gray}  │ ${C.dim}… ${lines.length - maxPreview} more lines${C.reset}\n`,
    );
  }

  process.stdout.write(`${C.gray}  ╰─ ${C.green}done${C.reset}\n\n`);
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

export function userPrompt(): void {
  if (activeSpinner) activeSpinner.stop();
  process.stdout.write(`\n${C.bold}${C.blue}❯${C.reset} `);
}

export function permissionPrompt(name: string, summary: string): void {
  if (activeSpinner) activeSpinner.stop();
  process.stdout.write(
    `${C.gray}  │${C.reset} ${C.yellow}⚠  Allow ${C.bold}${name}${C.reset}${C.yellow}?${C.reset}  ${C.dim}[${C.green}y${C.dim}]es / [${C.red}n${C.dim}]o / [${C.yellow}a${C.dim}]lways${C.reset}\n`,
  );
  if (summary) {
    process.stdout.write(
      `${C.gray}  │${C.reset}   ${C.dim}${summary}${C.reset}\n`,
    );
  }
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

export function banner(model: string, mode: string): void {
  if (activeSpinner) activeSpinner.stop();

  const width = 52;
  const border = `${C.gray}${"─".repeat(width)}${C.reset}`;

  console.log();
  console.log(border);
  console.log(
    `  ${C.bold}${C.cyan}🔓 Crack Code${C.reset}                ${C.dim}v0.1.0${C.reset}`,
  );
  console.log(border);
  console.log(`  ${C.gray}Model${C.reset}   ${C.white}${model}${C.reset}`);
  console.log(
    `  ${C.gray}Mode${C.reset}    ${mode === "read-only" ? `${C.green}● read-only` : `${C.yellow}● edits enabled`}${C.reset}`,
  );
  console.log(border);
  console.log(
    `  ${C.gray}Type ${C.white}/help${C.gray} for commands, ${C.white}/exit${C.gray} to quit${C.reset}`,
  );
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
