// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — TUI Prompt Utilities
// ─────────────────────────────────────────────────────────────────────────────
// Readline-based interactive input helpers for the terminal UI. Provides
// question prompts, password (masked) input, single-select menus, confirm
// dialogs, and multi-select support. Zero external dependencies — built
// entirely on Node's built-in `readline` module.
// ─────────────────────────────────────────────────────────────────────────────

import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import {
  cyan,
  green,
  yellow,
  red,
  dim,
  bold,
  white,
  brightCyan,
  brightGreen,
  gray,
  clearLine,
  cursorTo,
  cursorHide,
  cursorShow,
  stripAnsi,
  ARROW_RIGHT,
  CHECK_MARK,
  CROSS_MARK,
  BULLET_POINT,
  KEY_ICON,
} from "../utils/colors.js";

// ── Internal Helpers ────────────────────────────────────────────────────────

/** Create a readline interface bound to stdin/stdout */
function createRL(
  output: NodeJS.WritableStream = process.stdout,
): ReadlineInterface {
  return createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
}

/** Whether stdin is a TTY (interactive terminal) */
function isTTY(): boolean {
  return !!(process.stdin as NodeJS.ReadStream).isTTY;
}

/**
 * Write to stdout without a newline.
 */
function write(text: string): void {
  process.stdout.write(text);
}

/**
 * Write to stdout with a newline.
 */
function writeLine(text: string = ""): void {
  process.stdout.write(text + "\n");
}

// ── askQuestion ─────────────────────────────────────────────────────────────

/** Options for askQuestion */
export interface AskOptions {
  /** Default value if the user presses Enter without typing */
  defaultValue?: string;
  /** Validate the input; return an error message string or null/undefined if valid */
  validate?: (input: string) => string | null | undefined;
  /** Transform the input before returning (e.g. trim) */
  transform?: (input: string) => string;
  /** Whether empty input is allowed (default: true if defaultValue is set) */
  allowEmpty?: boolean;
  /** Hint text shown after the prompt in dim */
  hint?: string;
  /** Maximum number of validation retries before giving up (default: 5) */
  maxRetries?: number;
}

/**
 * Ask the user a question and return their answer.
 *
 * @param question - The question text to display.
 * @param options  - Configuration options.
 * @returns The user's input (or default value).
 */
export async function askQuestion(
  question: string,
  options: AskOptions = {},
): Promise<string> {
  const {
    defaultValue,
    validate,
    transform = (s: string) => s.trim(),
    allowEmpty = !!defaultValue,
    hint,
    maxRetries = 5,
  } = options;

  let attempts = 0;

  while (attempts < maxRetries) {
    const answer = await rawQuestion(question, defaultValue, hint);
    const transformed = transform(answer);

    // Use default if empty
    if (!transformed && defaultValue !== undefined) {
      return defaultValue;
    }

    // Check empty
    if (!transformed && !allowEmpty) {
      writeLine(red("  Input cannot be empty. Please try again."));
      attempts++;
      continue;
    }

    // Validate
    if (validate) {
      const error = validate(transformed);
      if (error) {
        writeLine(red(`  ${error}`));
        attempts++;
        continue;
      }
    }

    return transformed;
  }

  // Exhausted retries — return default or empty
  return defaultValue ?? "";
}

/**
 * Low-level question prompt using readline.
 */
function rawQuestion(
  question: string,
  defaultValue?: string,
  hint?: string,
): Promise<string> {
  return new Promise((resolve) => {
    const rl = createRL();

    let promptText = `  ${cyan(ARROW_RIGHT)} ${bold(question)}`;
    if (defaultValue) {
      promptText += ` ${dim(`(${defaultValue})`)}`;
    }
    if (hint) {
      promptText += ` ${dim(hint)}`;
    }
    promptText += " ";

    rl.question(promptText, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ── askPassword ─────────────────────────────────────────────────────────────

/** Options for askPassword */
export interface PasswordOptions {
  /** Mask character (default: '*') */
  mask?: string;
  /** Validate the input */
  validate?: (input: string) => string | null | undefined;
  /** Whether empty input is allowed (default: false) */
  allowEmpty?: boolean;
  /** Maximum retries (default: 5) */
  maxRetries?: number;
  /** Hint text */
  hint?: string;
}

/**
 * Ask the user for a password/secret with masked input.
 * Characters are replaced with the mask character as they type.
 *
 * @param question - The prompt text.
 * @param options  - Configuration options.
 * @returns The password string.
 */
export async function askPassword(
  question: string,
  options: PasswordOptions = {},
): Promise<string> {
  const {
    mask = "*",
    validate,
    allowEmpty = false,
    maxRetries = 5,
    hint,
  } = options;

  let attempts = 0;

  while (attempts < maxRetries) {
    const answer = await rawPassword(question, mask, hint);
    const trimmed = answer.trim();

    if (!trimmed && !allowEmpty) {
      writeLine(red("  Input cannot be empty. Please try again."));
      attempts++;
      continue;
    }

    if (validate) {
      const error = validate(trimmed);
      if (error) {
        writeLine(red(`  ${error}`));
        attempts++;
        continue;
      }
    }

    return trimmed;
  }

  return "";
}

/**
 * Low-level masked password input.
 *
 * This works by:
 * 1. Switching stdin to raw mode to intercept individual keystrokes.
 * 2. Echoing mask characters instead of the real input.
 * 3. Handling backspace, Ctrl+C, and Enter.
 */
function rawPassword(
  question: string,
  mask: string,
  hint?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let promptText = `  ${cyan(KEY_ICON)} ${bold(question)}`;
    if (hint) {
      promptText += ` ${dim(hint)}`;
    }
    promptText += " ";

    write(promptText);

    // If not a TTY, fall back to plain readline (e.g. piped input)
    if (!isTTY()) {
      const rl = createRL();
      rl.question("", (answer: string) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    const stdin = process.stdin as NodeJS.ReadStream;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    let input = "";

    const onData = (char: string): void => {
      const code = char.charCodeAt(0);

      // Ctrl+C
      if (char === "\x03") {
        stdin.setRawMode(wasRaw ?? false);
        stdin.removeListener("data", onData);
        stdin.pause();
        writeLine("");
        resolve("");
        return;
      }

      // Enter
      if (char === "\r" || char === "\n") {
        stdin.setRawMode(wasRaw ?? false);
        stdin.removeListener("data", onData);
        stdin.pause();
        writeLine("");
        resolve(input);
        return;
      }

      // Backspace / Delete
      if (code === 127 || code === 8) {
        if (input.length > 0) {
          input = input.slice(0, -1);
          // Move cursor back, write space, move back again
          write("\b \b");
        }
        return;
      }

      // Ignore non-printable characters
      if (code < 32) {
        return;
      }

      input += char;
      write(mask);
    };

    stdin.on("data", onData);
  });
}

// ── selectOption ────────────────────────────────────────────────────────────

/** A selectable option in a menu */
export interface SelectChoice<T = string> {
  /** The value returned when this option is selected */
  value: T;
  /** Display label */
  label: string;
  /** Optional description shown in dim below the label */
  description?: string;
  /** Whether this option is disabled */
  disabled?: boolean;
  /** Hint text shown next to disabled options */
  disabledHint?: string;
}

/** Options for selectOption */
export interface SelectOptions {
  /** Maximum visible items before scrolling (default: 10) */
  maxVisible?: number;
  /** Whether to show index numbers (default: true) */
  showNumbers?: boolean;
}

/**
 * Display an interactive single-select menu.
 *
 * If the terminal supports raw mode, uses arrow-key navigation with a
 * highlighted cursor. Otherwise, falls back to a numbered list prompt.
 *
 * @param question - The question/title shown above the choices.
 * @param choices  - Array of selectable options.
 * @param options  - Display options.
 * @returns The value of the selected choice, or null if cancelled.
 */
export async function selectOption<T = string>(
  question: string,
  choices: SelectChoice<T>[],
  options: SelectOptions = {},
): Promise<T | null> {
  if (choices.length === 0) {
    return null;
  }

  const { maxVisible = 10, showNumbers = true } = options;

  writeLine(`  ${cyan(ARROW_RIGHT)} ${bold(question)}`);

  // If not a TTY or few choices, use numbered fallback
  if (!isTTY()) {
    return numberedSelect(choices, showNumbers);
  }

  return arrowSelect(choices, maxVisible);
}

/**
 * Numbered-list fallback for non-TTY environments.
 */
async function numberedSelect<T>(
  choices: SelectChoice<T>[],
  showNumbers: boolean,
): Promise<T | null> {
  choices.forEach((choice, i) => {
    const num = showNumbers ? dim(`  ${i + 1}.`) : `  ${BULLET_POINT}`;
    const label = choice.disabled
      ? dim(`${choice.label} ${choice.disabledHint ?? "(unavailable)"}`)
      : choice.label;
    writeLine(`${num} ${label}`);
    if (choice.description && !choice.disabled) {
      writeLine(`     ${dim(choice.description)}`);
    }
  });

  const enabledIndices = choices
    .map((c, i) => (c.disabled ? -1 : i))
    .filter((i) => i >= 0);

  if (enabledIndices.length === 0) {
    writeLine(red("  No options available."));
    return null;
  }

  const answer = await askQuestion("Enter number", {
    validate: (input) => {
      const num = parseInt(input, 10);
      if (isNaN(num) || num < 1 || num > choices.length) {
        return `Please enter a number between 1 and ${choices.length}.`;
      }
      if (choices[num - 1]?.disabled) {
        return "That option is not available.";
      }
      return null;
    },
  });

  const idx = parseInt(answer, 10) - 1;
  const selected = choices[idx];
  return selected ? selected.value : null;
}

/**
 * Interactive arrow-key select using raw mode.
 */
function arrowSelect<T>(
  choices: SelectChoice<T>[],
  maxVisible: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin as NodeJS.ReadStream;
    const wasRaw = stdin.isRaw;

    let selectedIndex = choices.findIndex((c) => !c.disabled);
    if (selectedIndex === -1) {
      writeLine(red("  No options available."));
      resolve(null);
      return;
    }

    let scrollOffset = 0;
    let renderedLines = 0;

    function getVisibleRange(): { start: number; end: number } {
      const total = choices.length;
      const visible = Math.min(maxVisible, total);
      let start = scrollOffset;
      let end = start + visible;

      if (selectedIndex < start) {
        start = selectedIndex;
        end = start + visible;
      } else if (selectedIndex >= end) {
        end = selectedIndex + 1;
        start = end - visible;
      }

      scrollOffset = start;
      return { start, end: Math.min(end, total) };
    }

    function render(): void {
      // Clear previously rendered lines
      if (renderedLines > 0) {
        for (let i = 0; i < renderedLines; i++) {
          write("\x1B[A"); // move up
          write("\x1B[2K"); // clear line
        }
      }

      const { start, end } = getVisibleRange();
      const lines: string[] = [];

      for (let i = start; i < end; i++) {
        const choice = choices[i]!;
        const isSelected = i === selectedIndex;
        const pointer = isSelected ? brightCyan("\uF054") : " ";

        if (choice.disabled) {
          lines.push(
            `  ${pointer} ${dim(`${choice.label} ${choice.disabledHint ?? "(unavailable)"}`)}`,
          );
        } else if (isSelected) {
          lines.push(`  ${pointer} ${brightGreen(choice.label)}`);
          if (choice.description) {
            lines.push(`      ${dim(choice.description)}`);
          }
        } else {
          lines.push(`  ${pointer} ${white(choice.label)}`);
        }
      }

      // Scroll indicators
      if (start > 0) {
        lines.unshift(`  ${dim("↑ more")}`);
      }
      if (end < choices.length) {
        lines.push(`  ${dim("↓ more")}`);
      }

      lines.push(dim("  (↑/↓ navigate, Enter select, Esc/q cancel)"));

      renderedLines = lines.length;
      writeLine(lines.join("\n"));
    }

    function cleanup(): void {
      stdin.setRawMode(wasRaw ?? false);
      stdin.removeListener("data", onKey);
      stdin.pause();
      write(cursorShow());
    }

    write(cursorHide());
    render();

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    function onKey(key: string): void {
      // Escape or 'q'
      if (key === "\x1B" || key === "q") {
        // Check it's not an arrow sequence
        if (key === "\x1B") {
          // Could be start of escape sequence — wait briefly
          // But since we get full sequences in Node, standalone ESC is fine
          // Arrow keys come as \x1B[A, etc.
        }
        // For standalone Escape (no following chars in this chunk)
        if (key.length === 1) {
          cleanup();
          writeLine("");
          resolve(null);
          return;
        }
      }

      // Arrow Up
      if (key === "\x1B[A" || key === "k") {
        let next = selectedIndex - 1;
        while (next >= 0 && choices[next]?.disabled) {
          next--;
        }
        if (next >= 0) {
          selectedIndex = next;
          render();
        }
        return;
      }

      // Arrow Down
      if (key === "\x1B[B" || key === "j") {
        let next = selectedIndex + 1;
        while (next < choices.length && choices[next]?.disabled) {
          next++;
        }
        if (next < choices.length) {
          selectedIndex = next;
          render();
        }
        return;
      }

      // Enter
      if (key === "\r" || key === "\n") {
        const choice = choices[selectedIndex];
        cleanup();
        if (choice && !choice.disabled) {
          writeLine(`  ${green(CHECK_MARK)} ${choice.label}`);
          resolve(choice.value);
        } else {
          resolve(null);
        }
        return;
      }

      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        writeLine("");
        resolve(null);
        return;
      }

      // Number keys for quick selection
      const num = parseInt(key, 10);
      if (!isNaN(num) && num >= 1 && num <= choices.length) {
        const idx = num - 1;
        if (!choices[idx]?.disabled) {
          selectedIndex = idx;
          render();
        }
      }
    }

    stdin.on("data", onKey);
  });
}

// ── confirm ─────────────────────────────────────────────────────────────────

/** Options for confirm */
export interface ConfirmOptions {
  /** The default value when Enter is pressed (default: false) */
  defaultValue?: boolean;
}

/**
 * Ask a yes/no confirmation question.
 *
 * @param question - The question to ask.
 * @param options  - Configuration.
 * @returns true if the user confirmed, false otherwise.
 */
export async function confirm(
  question: string,
  options: ConfirmOptions = {},
): Promise<boolean> {
  const { defaultValue = false } = options;
  const hint = defaultValue ? "(Y/n)" : "(y/N)";

  const answer = await askQuestion(question, {
    hint,
    allowEmpty: true,
    defaultValue: defaultValue ? "y" : "n",
  });

  const lower = answer.toLowerCase().trim();

  if (lower === "" || lower === undefined) {
    return defaultValue;
  }

  return lower === "y" || lower === "yes" || lower === "true" || lower === "1";
}

// ── multiSelect ─────────────────────────────────────────────────────────────

/** Options for multiSelect */
export interface MultiSelectOptions {
  /** Maximum visible items (default: 10) */
  maxVisible?: number;
  /** Minimum number of selections required (default: 0) */
  minSelections?: number;
  /** Maximum number of selections allowed (default: unlimited) */
  maxSelections?: number;
  /** Indices that should be pre-selected */
  preSelected?: number[];
}

/**
 * Display an interactive multi-select menu.
 * Users can toggle selections with Space and confirm with Enter.
 *
 * @param question - The question/title shown above the choices.
 * @param choices  - Array of selectable options.
 * @param options  - Configuration.
 * @returns Array of selected values, or null if cancelled.
 */
export async function multiSelect<T = string>(
  question: string,
  choices: SelectChoice<T>[],
  options: MultiSelectOptions = {},
): Promise<T[] | null> {
  if (choices.length === 0) {
    return [];
  }

  const {
    maxVisible = 10,
    minSelections = 0,
    maxSelections = choices.length,
    preSelected = [],
  } = options;

  writeLine(`  ${cyan(ARROW_RIGHT)} ${bold(question)}`);

  if (!isTTY()) {
    return numberedMultiSelect(choices, preSelected);
  }

  return arrowMultiSelect(
    choices,
    maxVisible,
    minSelections,
    maxSelections,
    preSelected,
  );
}

/**
 * Numbered-list fallback for multi-select in non-TTY environments.
 */
async function numberedMultiSelect<T>(
  choices: SelectChoice<T>[],
  preSelected: number[],
): Promise<T[] | null> {
  choices.forEach((choice, i) => {
    const marker = preSelected.includes(i) ? green("[x]") : dim("[ ]");
    const label = choice.disabled
      ? dim(`${choice.label} ${choice.disabledHint ?? "(unavailable)"}`)
      : choice.label;
    writeLine(`  ${dim(`${i + 1}.`)} ${marker} ${label}`);
  });

  const answer = await askQuestion(
    "Enter numbers separated by commas (e.g. 1,3,5)",
    { allowEmpty: true },
  );

  if (!answer.trim()) {
    // Return pre-selected values
    return preSelected
      .filter((i) => i >= 0 && i < choices.length && !choices[i]?.disabled)
      .map((i) => choices[i]!.value);
  }

  const indices = answer
    .split(",")
    .map((s) => parseInt(s.trim(), 10) - 1)
    .filter((i) => i >= 0 && i < choices.length && !choices[i]?.disabled);

  return indices.map((i) => choices[i]!.value);
}

/**
 * Interactive arrow-key multi-select using raw mode.
 */
function arrowMultiSelect<T>(
  choices: SelectChoice<T>[],
  maxVisible: number,
  minSelections: number,
  maxSelections: number,
  preSelected: number[],
): Promise<T[] | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin as NodeJS.ReadStream;
    const wasRaw = stdin.isRaw;

    let selectedIndex = choices.findIndex((c) => !c.disabled);
    if (selectedIndex === -1) {
      writeLine(red("  No options available."));
      resolve(null);
      return;
    }

    const checked = new Set<number>(
      preSelected.filter(
        (i) => i >= 0 && i < choices.length && !choices[i]?.disabled,
      ),
    );
    let scrollOffset = 0;
    let renderedLines = 0;

    function getVisibleRange(): { start: number; end: number } {
      const total = choices.length;
      const visible = Math.min(maxVisible, total);
      let start = scrollOffset;
      let end = start + visible;

      if (selectedIndex < start) {
        start = selectedIndex;
        end = start + visible;
      } else if (selectedIndex >= end) {
        end = selectedIndex + 1;
        start = end - visible;
      }

      scrollOffset = start;
      return { start, end: Math.min(end, total) };
    }

    function render(): void {
      if (renderedLines > 0) {
        for (let i = 0; i < renderedLines; i++) {
          write("\x1B[A");
          write("\x1B[2K");
        }
      }

      const { start, end } = getVisibleRange();
      const lines: string[] = [];

      for (let i = start; i < end; i++) {
        const choice = choices[i]!;
        const isSelected = i === selectedIndex;
        const isChecked = checked.has(i);
        const pointer = isSelected ? brightCyan("\uF054") : " ";
        const checkbox = isChecked ? green("[\uF00C]") : dim("[ ]");

        if (choice.disabled) {
          lines.push(
            `  ${pointer} ${dim("[ ]")} ${dim(`${choice.label} ${choice.disabledHint ?? ""}`)}`,
          );
        } else if (isSelected) {
          lines.push(`  ${pointer} ${checkbox} ${brightGreen(choice.label)}`);
        } else {
          lines.push(`  ${pointer} ${checkbox} ${white(choice.label)}`);
        }
      }

      if (start > 0) {
        lines.unshift(`  ${dim("↑ more")}`);
      }
      if (end < choices.length) {
        lines.push(`  ${dim("↓ more")}`);
      }

      lines.push(
        dim(
          `  (↑/↓ navigate, Space toggle, Enter confirm, Esc cancel) [${checked.size} selected]`,
        ),
      );

      renderedLines = lines.length;
      writeLine(lines.join("\n"));
    }

    function cleanup(): void {
      stdin.setRawMode(wasRaw ?? false);
      stdin.removeListener("data", onKey);
      stdin.pause();
      write(cursorShow());
    }

    write(cursorHide());
    render();

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    function onKey(key: string): void {
      // Escape
      if (key === "\x1B" && key.length === 1) {
        cleanup();
        writeLine("");
        resolve(null);
        return;
      }

      // Arrow Up
      if (key === "\x1B[A" || key === "k") {
        let next = selectedIndex - 1;
        while (next >= 0 && choices[next]?.disabled) {
          next--;
        }
        if (next >= 0) {
          selectedIndex = next;
          render();
        }
        return;
      }

      // Arrow Down
      if (key === "\x1B[B" || key === "j") {
        let next = selectedIndex + 1;
        while (next < choices.length && choices[next]?.disabled) {
          next++;
        }
        if (next < choices.length) {
          selectedIndex = next;
          render();
        }
        return;
      }

      // Space — toggle selection
      if (key === " ") {
        const choice = choices[selectedIndex];
        if (choice && !choice.disabled) {
          if (checked.has(selectedIndex)) {
            checked.delete(selectedIndex);
          } else if (checked.size < maxSelections) {
            checked.add(selectedIndex);
          }
          render();
        }
        return;
      }

      // Enter — confirm
      if (key === "\r" || key === "\n") {
        if (checked.size < minSelections) {
          // Don't allow confirmation below minimum
          return;
        }
        cleanup();
        const selected = Array.from(checked)
          .sort((a, b) => a - b)
          .map((i) => choices[i]!)
          .filter((c) => !c.disabled);

        if (selected.length > 0) {
          writeLine(
            `  ${green(CHECK_MARK)} ${selected.map((c) => c.label).join(", ")}`,
          );
        } else {
          writeLine(`  ${dim("(none selected)")}`);
        }
        resolve(selected.map((c) => c.value));
        return;
      }

      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        writeLine("");
        resolve(null);
        return;
      }

      // 'a' — toggle all
      if (key === "a") {
        const allEnabled = choices
          .map((c, i) => (c.disabled ? -1 : i))
          .filter((i) => i >= 0);
        if (checked.size === allEnabled.length) {
          checked.clear();
        } else {
          allEnabled.forEach((i) => {
            if (checked.size < maxSelections) checked.add(i);
          });
        }
        render();
        return;
      }
    }

    stdin.on("data", onKey);
  });
}

// ── waitForKey ───────────────────────────────────────────────────────────────

/**
 * Wait for the user to press any key.
 *
 * @param message - Optional message to display (default: "Press any key to continue...")
 */
export async function waitForKey(
  message: string = "Press any key to continue...",
): Promise<void> {
  write(`  ${dim(message)} `);

  if (!isTTY()) {
    // In non-TTY mode, just wait for a line
    const rl = createRL();
    return new Promise((resolve) => {
      rl.question("", () => {
        rl.close();
        resolve();
      });
    });
  }

  return new Promise((resolve) => {
    const stdin = process.stdin as NodeJS.ReadStream;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    const onKey = (): void => {
      stdin.setRawMode(wasRaw ?? false);
      stdin.removeListener("data", onKey);
      stdin.pause();
      writeLine("");
      resolve();
    };

    stdin.on("data", onKey);
  });
}

// ── Inline Editor ───────────────────────────────────────────────────────────

/**
 * Ask the user a question with an editable default value pre-filled.
 * This uses readline's built-in write capability to pre-populate the input.
 *
 * @param question     - The prompt text.
 * @param defaultValue - Value to pre-fill in the input.
 * @returns The user's input.
 */
export async function askWithDefault(
  question: string,
  defaultValue: string,
): Promise<string> {
  return new Promise((resolve) => {
    const rl = createRL();

    const promptText = `  ${cyan(ARROW_RIGHT)} ${bold(question)} `;

    rl.question(promptText, (answer: string) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });

    // Pre-fill the default value so user can edit it
    rl.write(defaultValue);
  });
}

// ── Spinner Prompt ──────────────────────────────────────────────────────────

/**
 * Show a message while an async operation runs.
 * Returns the result of the operation.
 *
 * @param message   - Message to show while loading.
 * @param operation - Async function to execute.
 * @returns The result of the operation.
 */
export async function withSpinner<T>(
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frameIndex = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const isInteractive = isTTY();

  if (isInteractive) {
    write(cursorHide());
    const renderFrame = (): void => {
      write(`\r  ${cyan(frames[frameIndex % frames.length]!)} ${message}`);
      frameIndex++;
    };
    renderFrame();
    timer = setInterval(renderFrame, 80);
  } else {
    writeLine(`  ${message}...`);
  }

  try {
    const result = await operation();

    if (timer) clearInterval(timer);
    if (isInteractive) {
      write(`\r\x1B[2K  ${green(CHECK_MARK)} ${message}\n`);
      write(cursorShow());
    }

    return result;
  } catch (error) {
    if (timer) clearInterval(timer);
    if (isInteractive) {
      const errMsg = error instanceof Error ? error.message : String(error);
      write(`\r\x1B[2K  ${red(CROSS_MARK)} ${message} — ${red(errMsg)}\n`);
      write(cursorShow());
    }
    throw error;
  }
}

// ── Status Messages ─────────────────────────────────────────────────────────

/**
 * Print a success message.
 */
export function printSuccess(message: string): void {
  writeLine(`  ${green(CHECK_MARK)} ${message}`);
}

/**
 * Print an error message.
 */
export function printError(message: string): void {
  writeLine(`  ${red(CROSS_MARK)} ${message}`);
}

/**
 * Print a warning message.
 */
export function printWarning(message: string): void {
  writeLine(`  ${yellow("\uF071")} ${message}`);
}

/**
 * Print an info message.
 */
export function printInfo(message: string): void {
  writeLine(`  ${cyan("ℹ")} ${message}`);
}

/**
 * Print a blank line.
 */
export function printBlank(): void {
  writeLine("");
}

/**
 * Print a section divider with optional title.
 */
export function printDivider(title?: string, width: number = 60): void {
  if (title) {
    const line = "─".repeat(Math.max(2, width - title.length - 4));
    writeLine(`  ${dim(`── ${title} ${line}`)}`);
  } else {
    writeLine(`  ${dim("─".repeat(width))}`);
  }
}
