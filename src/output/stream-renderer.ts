import {
  bold,
  dim,
  gray,
  green,
  red,
  white,
  brightCyan,
  cyan,
  blue,
  underline,
  BULLET_POINT,
} from "../utils/colors";

// ── Helpers ─────────────────────────────────────────────────────────────────

function getTermWidth(): number {
  return process.stdout.columns || 80;
}

/**
 * Word-wrap a plain string into lines that fit within `width` visible
 * characters.  Long unbreakable tokens are force-split.
 */
function wordWrap(text: string, width: number): string[] {
  if (!text) return [];
  if (width < 1) width = 1;

  const lines: string[] = [];
  const words = text.split(" ");
  let currentLine = "";

  for (const word of words) {
    // Force-split words wider than the available width
    if (word.length > width) {
      if (currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = "";
      }
      let remaining = word;
      while (remaining.length > width) {
        lines.push(remaining.slice(0, width));
        remaining = remaining.slice(width);
      }
      if (remaining.length > 0) {
        currentLine = remaining;
      }
      continue;
    }

    const sep = currentLine.length === 0 ? 0 : 1;
    if (currentLine.length + word.length + sep <= width) {
      currentLine += (sep ? " " : "") + word;
    } else {
      if (currentLine.length > 0) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine.length > 0) lines.push(currentLine);

  return lines;
}

// ── Regex helpers ───────────────────────────────────────────────────────────

/** Matches the opening of a fenced code block: ``` or ~~~ with optional lang */
const FENCE_OPEN_RE = /^(`{3,}|~{3,})\s*(.*)$/;

/** Matches a horizontal rule: three or more -, *, or _ optionally spaced */
const HR_RE = /^(?:[-*_]\s*){3,}$/;

/** Matches an ordered-list item: "1. ", "2) ", etc. */
const OL_RE = /^(\d+)[.)]\s+(.*)$/;

/** Matches an unordered-list item: "- ", "* ", "+ " */
const UL_RE = /^[-*+]\s+(.*)$/;

/** Matches a Markdown heading: "# ", "## ", etc. */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Matches a blockquote line: "> ..." or ">" (empty) */
const BQ_RE = /^>\s?(.*)$/;

// ═════════════════════════════════════════════════════════════════════════════
// StreamRenderer
// ═════════════════════════════════════════════════════════════════════════════
//
// Consumes incremental text deltas from an AI streaming response and renders
// them to the terminal with Markdown-aware formatting:
//
//   • Headings (# … ######)
//   • Fenced code blocks (``` and ~~~) with language labels and diff coloring
//   • Inline formatting: **bold**, *italic*, `code`, [links](url)
//   • Unordered lists (-, *, +)
//   • Ordered / numbered lists (1. / 1))
//   • Blockquotes (>)
//   • Horizontal rules (---, ***, ___)
//   • Empty-line paragraph separators
//
// Text is buffered until a full line (terminated by \n) is available, then
// rendered immediately so output streams in real-time.
// ═════════════════════════════════════════════════════════════════════════════

export interface StreamRendererOptions {
  prefix?: string;
  firstLinePrefix?: string;
  dimText?: boolean;
}

export class StreamRenderer {
  // ── Internal state ──────────────────────────────────────────────────────

  private prefix: string;
  private firstLinePrefix: string;
  private isFirstLineRendered = false;
  private dimText: boolean;

  constructor(options?: StreamRendererOptions) {
    this.prefix = options?.prefix ?? "  ";
    this.firstLinePrefix = options?.firstLinePrefix ?? this.prefix;
    this.dimText = options?.dimText ?? false;
  }

  /** Partial-line buffer (text received but not yet terminated by \n). */
  private buffer = "";

  /** Whether we are inside a fenced code block. */
  private inCodeBlock = false;

  /** The fence token that opened the current code block (e.g. "```"). */
  private codeFenceToken = "";

  /** Language tag of the current code block (e.g. "ts", "diff"). */
  private codeBlockLang = "";

  /** Whether `append()` has been called at least once. */
  private isFirstLine = true;

  /** Running count of code-block body lines (for the gutter). */
  private codeLineNumber = 0;

  /** Tracks the last rendered element type so we can collapse blank lines. */
  private lastElementType:
    | "blank"
    | "heading"
    | "code"
    | "list"
    | "hr"
    | "blockquote"
    | "text"
    | "thinking" = "blank";

  /** Whether the current text stream is inside a <thinking> or <think> block. */
  private inThinkingBlock = false;
  /** Tracks the first rendered line inside a thinking block to use the spinner icon. */
  private isFirstThinkingLine = true;

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Feed a chunk of streamed text into the renderer.
   *
   * Complete lines (ending with `\n`) are rendered immediately.  Partial
   * trailing text is buffered until the next `append()` or `end()`.
   */
  public append(text: string): void {
    if (this.isFirstLine) {
      process.stdout.write("\n");
      this.isFirstLine = false;
    }

    this.buffer += text;

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.renderLine(line);
    }
  }

  /**
   * Flush any remaining buffered text and emit a trailing newline.
   *
   * Always call this when the stream completes so partial lines are not lost
   * and any open code block is visually closed.
   */
  public end(): void {
    // Flush partial buffer
    if (this.buffer.length > 0) {
      this.renderLine(this.buffer);
      this.buffer = "";
    }

    // If we were inside a code block that was never closed, close it visually
    if (this.inCodeBlock) {
      this.inCodeBlock = false;
      this.codeBlockLang = "";
      this.codeFenceToken = "";
      this.codeLineNumber = 0;
    }

    process.stdout.write("\n");
  }

  // ── Line renderer ───────────────────────────────────────────────────────

  private renderLine(line: string): void {
    let processedLine = line;
    const trimmedBeforeTags = processedLine.trim();

    // Check for thinking blocks
    const hasThinkStart = /<think(?:ing)?>/i.test(processedLine);
    const hasThinkEnd = /<\/think(?:ing)?>/i.test(processedLine);

    if (hasThinkStart) {
      this.inThinkingBlock = true;
      this.isFirstThinkingLine = true;
      processedLine = processedLine.replace(/<think(?:ing)?>/gi, "");
    }
    if (hasThinkEnd) {
      this.inThinkingBlock = false;
      processedLine = processedLine.replace(/<\/think(?:ing)?>/gi, "");
    }

    const trimmed = processedLine.trim();

    // If the line only contained tags and is now empty, skip rendering it
    if (trimmed === "" && (hasThinkStart || hasThinkEnd)) {
      return;
    }

    const width = getTermWidth();

    if (trimmed === "" && !this.inCodeBlock && !this.inThinkingBlock) {
      // Collapse consecutive blank lines
      if (this.lastElementType !== "blank") {
        process.stdout.write("\n");
      }
      this.lastElementType = "blank";
      return;
    }

    const pfx = this.isFirstLineRendered ? this.prefix : this.firstLinePrefix;
    this.isFirstLineRendered = true;

    // ── Inside thinking block ───────────────────────────────────────────
    if (this.inThinkingBlock) {
      const wrapped = wordWrap(processedLine, width - 4);
      for (const wl of wrapped) {
        const linePfx = this.isFirstThinkingLine
          ? `  ${cyan("◐")} `
          : `  ${dim("│")} `;
        const colored = dim(gray(this.formatInline(wl)));
        process.stdout.write(`${linePfx}${colored}\n`);
        this.isFirstThinkingLine = false;
      }
      this.lastElementType = "thinking";
      return;
    }

    // ── Inside a code block ─────────────────────────────────────────────

    if (this.inCodeBlock) {
      // Check for closing fence — must use the same token (``` or ~~~)
      if (this.isClosingFence(trimmed)) {
        this.inCodeBlock = false;
        this.codeBlockLang = "";
        this.codeFenceToken = "";
        this.codeLineNumber = 0;
        // Don't render the closing fence itself
        return;
      }

      this.codeLineNumber++;
      this.renderCodeLine(line, pfx);
      this.lastElementType = "code";
      return;
    }

    // ── Opening fence ───────────────────────────────────────────────────

    const fenceMatch = trimmed.match(FENCE_OPEN_RE);
    if (fenceMatch) {
      this.inCodeBlock = true;
      this.codeFenceToken = fenceMatch[1]!.charAt(0); // "`" or "~"
      this.codeBlockLang = (fenceMatch[2] ?? "").trim().toLowerCase();
      this.codeLineNumber = 0;

      // Render a label line for the code block
      if (this.codeBlockLang) {
        process.stdout.write(`${pfx}${dim("┌")} ${dim(this.codeBlockLang)}\n`);
      } else {
        process.stdout.write(`${pfx}${dim("┌")}\n`);
      }
      this.lastElementType = "code";
      return;
    }

    // ── Horizontal rule ─────────────────────────────────────────────────

    if (HR_RE.test(trimmed) && trimmed.length >= 3) {
      const ruleWidth = Math.min(width - 4, 60);
      process.stdout.write(`${pfx}${dim("─".repeat(ruleWidth))}\n`);
      this.lastElementType = "hr";
      return;
    }

    // ── Headings ────────────────────────────────────────────────────────

    const headingMatch = trimmed.match(HEADING_RE);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!;
      this.renderHeading(text, level, width, pfx);
      this.lastElementType = "heading";
      return;
    }

    // ── Blockquote ──────────────────────────────────────────────────────

    const bqMatch = trimmed.match(BQ_RE);
    if (bqMatch) {
      const content = bqMatch[1] ?? "";
      const wrapped = wordWrap(content, width - 6);
      if (wrapped.length === 0) {
        process.stdout.write(`${pfx}${dim("│")}\n`);
      } else {
        for (const wl of wrapped) {
          const formatted = this.formatInline(wl);
          const colored = this.dimText ? dim(formatted) : dim(formatted);
          process.stdout.write(`${pfx}${dim("│")} ${colored}\n`);
        }
      }
      this.lastElementType = "blockquote";
      return;
    }

    // ── Unordered list ──────────────────────────────────────────────────

    const ulMatch = trimmed.match(UL_RE);
    if (ulMatch) {
      const content = ulMatch[1]!;
      const wrapped = wordWrap(content, width - 6);
      if (wrapped.length > 0) {
        const formattedFirst = this.formatInline(wrapped[0]!);
        const coloredFirst = this.dimText
          ? dim(formattedFirst)
          : white(formattedFirst);
        process.stdout.write(`${pfx}${green(BULLET_POINT)} ${coloredFirst}\n`);
        for (let i = 1; i < wrapped.length; i++) {
          const formatted = this.formatInline(wrapped[i]!);
          const colored = this.dimText ? dim(formatted) : white(formatted);
          process.stdout.write(`${this.prefix}  ${colored}\n`);
        }
      }
      this.lastElementType = "list";
      return;
    }

    // ── Ordered list ────────────────────────────────────────────────────

    const olMatch = trimmed.match(OL_RE);
    if (olMatch) {
      const num = olMatch[1]!;
      const content = olMatch[2]!;
      const prefix = `${dim(num + ".")} `;
      const prefixVisibleLen = num.length + 2; // "N. "
      const wrapped = wordWrap(content, width - 4 - prefixVisibleLen);
      if (wrapped.length > 0) {
        const formattedFirst = this.formatInline(wrapped[0]!);
        const coloredFirst = this.dimText
          ? dim(formattedFirst)
          : white(formattedFirst);
        process.stdout.write(`${pfx}${prefix}${coloredFirst}\n`);
        const indent = " ".repeat(prefixVisibleLen);
        for (let i = 1; i < wrapped.length; i++) {
          const formatted = this.formatInline(wrapped[i]!);
          const colored = this.dimText ? dim(formatted) : white(formatted);
          process.stdout.write(`${this.prefix}${indent}${colored}\n`);
        }
      }
      this.lastElementType = "list";
      return;
    }

    // ── Regular paragraph text ──────────────────────────────────────────

    const wrapped = wordWrap(line, width - 4);
    for (let i = 0; i < wrapped.length; i++) {
      const wl = wrapped[i]!;
      const linePfx = i === 0 ? pfx : this.prefix;
      const formatted = this.formatInline(wl);
      const colored = this.dimText ? dim(formatted) : white(formatted);
      process.stdout.write(`${linePfx}${colored}\n`);
    }
    this.lastElementType = "text";
  }

  // ── Code block helpers ────────────────────────────────────────────────

  /**
   * Check whether `trimmed` is a closing fence that matches the opener.
   */
  private isClosingFence(trimmed: string): boolean {
    if (!this.codeFenceToken) return false;

    // A closing fence must start with at least 3 of the same char
    const match = trimmed.match(FENCE_OPEN_RE);
    if (!match) return false;

    const fenceChar = match[1]!.charAt(0);
    // Must be the same type (` or ~) and no info string on the closer
    return fenceChar === this.codeFenceToken && (match[2] ?? "").trim() === "";
  }

  /**
   * Render a single line inside a fenced code block, with optional
   * diff-aware coloring.
   */
  private renderCodeLine(line: string, pfx: string): void {
    const gutter = dim("│");

    if (this.codeBlockLang === "diff") {
      if (line.startsWith("+")) {
        process.stdout.write(`${pfx}${gutter} ${green(line)}\n`);
      } else if (line.startsWith("-")) {
        process.stdout.write(`${pfx}${gutter} ${red(line)}\n`);
      } else if (line.startsWith("@@")) {
        process.stdout.write(`${pfx}${gutter} ${cyan(line)}\n`);
      } else {
        process.stdout.write(`${pfx}${gutter} ${gray(line)}\n`);
      }
    } else {
      process.stdout.write(`${pfx}${gutter} ${gray(line)}\n`);
    }
  }

  // ── Heading helper ────────────────────────────────────────────────────

  private renderHeading(
    text: string,
    level: number,
    width: number,
    pfx: string,
  ): void {
    const wrapped = wordWrap(text, width - 4);

    // Add a blank line before headings (unless we're already after one)
    if (
      this.lastElementType !== "blank" &&
      this.lastElementType !== "heading"
    ) {
      process.stdout.write("\n");
    }

    if (level <= 2) {
      // Major headings — bold + bright cyan
      for (let i = 0; i < wrapped.length; i++) {
        const wl = wrapped[i]!;
        const linePfx = i === 0 ? pfx : this.prefix;
        const formatted = this.formatInline(wl);
        const colored = this.dimText
          ? dim(bold(brightCyan(formatted)))
          : bold(brightCyan(formatted));
        process.stdout.write(`${linePfx}${colored}\n`);
      }
    } else if (level <= 4) {
      // Sub-headings — bold + cyan
      for (let i = 0; i < wrapped.length; i++) {
        const wl = wrapped[i]!;
        const linePfx = i === 0 ? pfx : this.prefix;
        const formatted = this.formatInline(wl);
        const colored = this.dimText
          ? dim(bold(cyan(formatted)))
          : bold(cyan(formatted));
        process.stdout.write(`${linePfx}${colored}\n`);
      }
    } else {
      // Minor headings — bold + white
      for (let i = 0; i < wrapped.length; i++) {
        const wl = wrapped[i]!;
        const linePfx = i === 0 ? pfx : this.prefix;
        const formatted = this.formatInline(wl);
        const colored = this.dimText
          ? dim(bold(white(formatted)))
          : bold(white(formatted));
        process.stdout.write(`${linePfx}${colored}\n`);
      }
    }
  }

  // ── Inline formatting ─────────────────────────────────────────────────

  /**
   * Apply inline Markdown formatting to a single line of text:
   *   **bold**, *italic*, _italic_, `code`, [text](url)
   *
   * Patterns are applied in specificity order so that `**bold**` is not
   * consumed by the single-star italic pass.
   */
  private formatInline(text: string): string {
    let formatted = text;

    // Links: [text](url) → text (url)
    formatted = formatted.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, linkText: string, url: string) =>
        `${underline(blue(linkText))} ${dim("(")}${dim(url)}${dim(")")}`,
    );

    // Bold: **text** or __text__
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, (_, p1: string) =>
      bold(p1),
    );
    formatted = formatted.replace(/__(.+?)__/g, (_, p1: string) => bold(p1));

    // Inline code: `code`  (must come before italic so backtick-wrapped
    // content is not re-interpreted)
    formatted = formatted.replace(/`([^`]+)`/g, (_, p1: string) => cyan(p1));

    // Italic: *text* or _text_  (single delimiter — after bold is consumed)
    formatted = formatted.replace(/\*(.+?)\*/g, (_, p1: string) => dim(p1));
    formatted = formatted.replace(/(?<!\w)_(.+?)_(?!\w)/g, (_, p1: string) =>
      dim(p1),
    );

    // Strikethrough: ~~text~~
    formatted = formatted.replace(/~~(.+?)~~/g, (_, p1: string) => dim(p1));

    return formatted;
  }
}
