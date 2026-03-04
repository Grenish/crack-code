const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  under: "\x1b[4m",

  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
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

// --- Core Output ---

export function streamText(chunk: string): void {
  process.stdout.write(chunk);
}

export function newline(): void {
  process.stdout.write("\n");
}

export function clearLine(): void {
  process.stdout.write("\r\x1b[K");
}

// --- Tool Calls ---

export function toolStart(name: string, args?: unknown): void {
  const summary = args ? truncate(formatArgs(name, args), 100) : "";
  process.stdout.write(
    `\n${C.gray}╭─ ${C.cyan}${C.bold}${name}${C.reset}${summary ? ` ${C.gray}${summary}` : ""}${C.reset}\n`,
  );
}

export function toolEnd(name: string, result: string): void {
  const lines = result.split("\n");
  const maxPreview = 6;
  const preview = lines.slice(0, maxPreview);

  for (const line of preview) {
    process.stdout.write(`${C.gray}│${C.reset} ${line}\n`);
  }

  if (lines.length > maxPreview) {
    process.stdout.write(
      `${C.gray}│ ... ${lines.length - maxPreview} more lines${C.reset}\n`,
    );
  }

  process.stdout.write(`${C.gray}╰─ done${C.reset}\n\n`);
}

export function toolBlocked(name: string, reason: string): void {
  process.stdout.write(`\n${C.gray}╭─ ${C.red}${name}${C.reset}\n`);
  process.stdout.write(`${C.gray}│${C.reset} ${C.red}⛔ ${reason}${C.reset}\n`);
  process.stdout.write(`${C.gray}╰─${C.reset}\n\n`);
}

// --- Severity ---

export function severity(level: string): void {
  const key = level.toUpperCase() as Severity;
  const style = SEVERITY_STYLE[key];
  if (style) {
    process.stdout.write(`${style.badge} `);
  } else {
    process.stdout.write(`${C.dim}[${level}]${C.reset} `);
  }
}

// --- Spinner ---

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerHandle {
  update: (text: string) => void;
  stop: () => void;
}

export function spinner(text: string): SpinnerHandle {
  let i = 0;
  let current = text;

  const id = setInterval(() => {
    const frame = SPINNER_FRAMES[i++ % SPINNER_FRAMES.length];
    process.stdout.write(
      `\r\x1b[K${C.cyan}${frame}${C.reset} ${C.gray}${current}${C.reset}`,
    );
  }, 80);

  return {
    update(newText: string) {
      current = newText;
    },
    stop() {
      clearInterval(id);
      process.stdout.write("\r\x1b[K");
    },
  };
}

// --- Prompts ---

export function userPrompt(): void {
  process.stdout.write(`\n${C.bold}${C.blue}❯${C.reset} `);
}

export function permissionPrompt(name: string, summary: string): void {
  process.stdout.write(
    `\n${C.yellow}⚠  Allow ${C.bold}${name}${C.reset}${C.yellow}?${C.reset}\n`,
  );
  process.stdout.write(`${C.gray}   ${summary}${C.reset}\n`);
}

// --- Status ---

export function info(msg: string): void {
  console.log(`${C.gray}${msg}${C.reset}`);
}

export function success(msg: string): void {
  console.log(`${C.green}✓ ${msg}${C.reset}`);
}

export function warn(msg: string): void {
  console.log(`${C.yellow}⚠ ${msg}${C.reset}`);
}

export function error(msg: string): void {
  console.error(`${C.red}✗ ${msg}${C.reset}`);
}

export function dim(msg: string): void {
  console.log(`${C.gray}${msg}${C.reset}`);
}

// --- Banner ---

export function banner(model: string, mode: string): void {
  console.log();
  console.log(`${C.bold}${C.cyan}Crack Code${C.reset}`);
  console.log(`${C.gray}  Model: ${C.white}${model}${C.reset}`);
  console.log(
    `${C.gray}  Mode:  ${mode === "read-only" ? `${C.green}read-only` : `${C.yellow}edits enabled`}${C.reset}`,
  );
  console.log(
    `${C.gray}  Type ${C.white}/help${C.gray} for commands, ${C.white}/exit${C.gray} to quit${C.reset}`,
  );
  console.log();
}

// --- Helpers ---

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
