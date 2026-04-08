import type { ModelMessage, LanguageModel } from "ai";
import type { Config } from "./config.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { PermissionManager } from "./permissions/index.js";
import { runAgent, type TokenUsage } from "./agent.js";
import * as ui from "./ui/renderer.js";

// Types

interface ReplContext {
  model: LanguageModel;
  config: Config;
  tools: ToolRegistry;
  permissions: PermissionManager;
  messages: ModelMessage[];
  totalUsage: TokenUsage;
}

interface SlashCommand {
  description: string;
  handler: (ctx: ReplContext, args: string) => void | Promise<void>;
}

interface InputController {
  readLine: () => Promise<string>;
  close: () => void;
}

// Slash Commands

const commands: Record<string, SlashCommand> = {
  "/help": {
    description: "Show available commands",
    handler: () => {
      console.log();
      for (const [name, cmd] of Object.entries(commands)) {
        console.log(`  \x1b[36m${name.padEnd(14)}\x1b[0m ${cmd.description}`);
      }
      console.log();
    },
  },

  "/exit": {
    description: "Exit Crack Code",
    handler: () => {
      ui.info("Goodbye.");
      process.exit(0);
    },
  },

  "/clear": {
    description: "Clear conversation history",
    handler: (ctx) => {
      ctx.messages = [];
      ctx.totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      ctx.permissions.clearSession();
      ui.success("Conversation cleared.");
    },
  },

  "/usage": {
    description: "Show token usage for this session",
    handler: (ctx) => {
      console.log();
      ui.dim(`  Input tokens:      ${ctx.totalUsage.inputTokens}`);
      ui.dim(`  Output tokens:     ${ctx.totalUsage.outputTokens}`);
      ui.dim(`  Total tokens:      ${ctx.totalUsage.totalTokens}`);
      ui.dim(`  Messages in context: ${ctx.messages.length}`);
      console.log();
    },
  },

  "/mode": {
    description: "Toggle read-only ↔ edit mode",
    handler: (ctx) => {
      ctx.config.allowEdits = !ctx.config.allowEdits;
      if (ctx.config.allowEdits) {
        ui.warn("Edit mode enabled. The AI can now modify files.");
      } else {
        ui.success("Read-only mode. The AI can only read and analyze.");
      }
    },
  },

  "/model": {
    description: "Show current model and provider",
    handler: (ctx) => {
      console.log();
      ui.dim(`  Provider: ${ctx.config.provider}`);
      ui.dim(`  Model:    ${ctx.config.model}`);
      console.log();
    },
  },

  "/policy": {
    description: "Show or set permission policy (ask/skip/allow-all/deny-all)",
    handler: (ctx, args) => {
      if (!args) {
        ui.dim(`  Current policy: ${ctx.permissions.getPolicy()}`);
        return;
      }
      const valid = ["ask", "skip", "allow-all", "deny-all"];
      if (!valid.includes(args)) {
        ui.error(`Invalid policy. Use: ${valid.join(", ")}`);
        return;
      }
      ctx.permissions.setPolicy(args as any);
      ui.success(`Permission policy set to: ${args}`);
    },
  },

  "/compact": {
    description: "Summarize conversation to reduce context size",
    handler: async (ctx) => {
      const count = ctx.messages.length;
      if (count <= 2) {
        ui.info("Conversation too short to compact.");
        return;
      }

      const loading = ui.spinner("Compacting conversation...");

      const toSummarize = ctx.messages.slice(0, -2);
      const recent = ctx.messages.slice(-2);

      const summaryText = toSummarize
        .map((m) => {
          const content =
            typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content);
          return `[${m.role}]: ${content.slice(0, 200)}`;
        })
        .join("\n");

      ctx.messages = [
        {
          role: "user",
          content: `[Previous conversation summary — ${count - 2} messages]\n${summaryText.slice(0, 2000)}`,
        },
        ...recent,
      ];

      loading.stop();
      ui.success(
        `Compacted ${count} messages → ${ctx.messages.length} messages.`,
      );
    },
  },
};

// Input handling: raw-mode realtime line editor with lightweight hints

function createInput(): InputController {
  const stdin = process.stdin;
  const stdout = process.stdout;

  const isTTY = Boolean(stdin.isTTY && stdout.isTTY);
  let closed = false;

  let pendingResolve: ((line: string) => void) | null = null;
  let line = "";
  let cursor = 0;

  let activeHint = "";

  const commandHints = [
    "/help  show commands",
    "/clear clear history",
    "/usage session tokens",
    "/mode  toggle read-only/edit",
    "/model show model",
    "/policy set permission mode",
    "/compact shrink context",
    "/exit  quit",
  ];

  const cleanupTerminalState = () => {
    if (!isTTY) return;
    try {
      stdin.setRawMode(false);
    } catch {
      // ignore
    }
    stdin.pause();
    stdout.write("\n");
  };

  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

  const visibleLen = (s: string): number => stripAnsi(s).length;

  const clearPromptRegion = () => {
    // Clear exactly the two prompt lines (input + hint), then return to input row.
    stdout.write("\r\x1b[2K"); // clear current line
    stdout.write("\x1b[1B\r\x1b[2K"); // clear next line
    stdout.write("\x1b[1A\r"); // back to input line start
  };

  const renderInput = () => {
    if (!pendingResolve || !isTTY) return;

    const termWidth = Math.max(40, stdout.columns || 120);
    const commandMode = line.startsWith("/");
    const askMode = line.startsWith("?");

    if (commandMode) {
      if (line.trim() === "/") {
        activeHint = `\x1b[90m${commandHints.join("   \x1b[2m|\x1b[0m \x1b[90m")}\x1b[0m`;
      } else {
        const needle = line.trim().toLowerCase();
        const matches = Object.keys(commands)
          .filter((c) => c.startsWith(needle))
          .slice(0, 6);

        if (matches.length > 0) {
          activeHint = `\x1b[90m${matches
            .map((m) => `${m} — ${commands[m]?.description ?? ""}`)
            .join("   \x1b[2m|\x1b[0m \x1b[90m")}\x1b[0m`;
        } else {
          activeHint = "\x1b[90mNo matching command. Try /help\x1b[0m";
        }
      }
    } else if (askMode) {
      activeHint =
        "\x1b[90mQuick ask mode: ask a short question and press Enter\x1b[0m";
    } else {
      activeHint =
        "\x1b[90mType / for commands, ? for quick ask, Enter to send\x1b[0m";
    }

    const prompt = "\x1b[1m\x1b[36m❯\x1b[0m ";
    // Draw input + hint on a fixed 2-line surface so keystrokes don't stack lines.
    clearPromptRegion();

    let hint = activeHint;
    if (visibleLen(hint) > termWidth) {
      const plain = stripAnsi(hint);
      hint = `\x1b[90m${plain.slice(0, Math.max(0, termWidth - 1))}…\x1b[0m`;
    }

    const promptVisible = visibleLen(prompt);
    const inputWidth = Math.max(10, termWidth - promptVisible);
    let displayStart = 0;

    if (line.length > inputWidth) {
      if (cursor <= inputWidth) {
        displayStart = 0;
      } else if (cursor >= line.length - 1) {
        displayStart = line.length - inputWidth;
      } else {
        displayStart = Math.max(0, cursor - Math.floor(inputWidth / 2));
        if (displayStart + inputWidth > line.length) {
          displayStart = line.length - inputWidth;
        }
      }
    }

    const displayLine = line.slice(displayStart, displayStart + inputWidth);

    stdout.write(`${prompt}${displayLine}\n`);
    stdout.write(`${hint}`);
    stdout.write("\x1b[1A\r"); // back to input line start
    stdout.write(prompt);

    const cursorInWindow = Math.max(0, cursor - displayStart);
    if (cursorInWindow > 0) {
      stdout.write(`\x1b[${cursorInWindow}C`);
    }
  };

  const finishLine = (value: string) => {
    const resolve = pendingResolve;
    pendingResolve = null;
    line = "";
    cursor = 0;
    activeHint = "";
    // Move from input line to hint line, then to a fresh line below the fixed 2-line surface.
    stdout.write("\x1b[1B\r\x1b[K\n");
    resolve?.(value.trim());
  };

  const onData = (chunk: Buffer | string) => {
    if (!pendingResolve) return;
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");

    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;

      // Ctrl+C
      if (ch === "\u0003") {
        cleanupTerminalState();
        ui.info("Goodbye.");
        process.exit(0);
      }

      // Enter
      if (ch === "\r" || ch === "\n") {
        finishLine(line);
        return;
      }

      // Backspace / DEL
      if (ch === "\u007f" || ch === "\b") {
        if (cursor > 0) {
          line = line.slice(0, cursor - 1) + line.slice(cursor);
          cursor--;
          renderInput();
        }
        continue;
      }

      // ESC sequences (arrows)
      if (ch === "\u001b") {
        const next1 = s[i + 1];
        const next2 = s[i + 2];
        if (next1 === "[") {
          if (next2 === "D") {
            // left
            if (cursor > 0) cursor--;
            i += 2;
            renderInput();
            continue;
          }
          if (next2 === "C") {
            // right
            if (cursor < line.length) cursor++;
            i += 2;
            renderInput();
            continue;
          }
          if (next2 === "H") {
            // home
            cursor = 0;
            i += 2;
            renderInput();
            continue;
          }
          if (next2 === "F") {
            // end
            cursor = line.length;
            i += 2;
            renderInput();
            continue;
          }
        }
        continue;
      }

      // Printable chars
      if (ch >= " " && ch !== "\u007f") {
        line = line.slice(0, cursor) + ch + line.slice(cursor);
        cursor++;
        renderInput();
      }
    }
  };

  if (isTTY) {
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.setRawMode(true);
    stdin.on("data", onData);
  } else {
    // Non-TTY fallback: simple line reads from stdin chunks
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  }

  return {
    readLine: () =>
      new Promise<string>((resolve) => {
        if (closed) {
          resolve("");
          return;
        }

        pendingResolve = resolve;
        line = "";
        cursor = 0;

        ui.userPrompt("");
        renderInput();
      }),

    close: () => {
      if (closed) return;
      closed = true;
      pendingResolve = null;
      stdin.removeListener("data", onData);
      cleanupTerminalState();
    },
  };
}

// Main REPL Loop

export async function startRepl(
  model: LanguageModel,
  config: Config,
  tools: ToolRegistry,
  permissions: PermissionManager,
): Promise<void> {
  const ctx: ReplContext = {
    model,
    config,
    tools,
    permissions,
    messages: [],
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };

  const mode = config.allowEdits ? "edits enabled" : "read-only";
  const workspace = config.cwd;
  const policy = permissions.getPolicy();

  ui.banner(
    config.model,
    mode,
    config.provider,
    workspace,
    policy,
    ctx.messages.length,
    config.userName,
  );

  const input = createInput();

  while (true) {
    const userLine = await input.readLine();

    if (!userLine) continue;

    const line = userLine.startsWith("?")
      ? userLine.slice(1).trim() || "Help me with this quickly."
      : userLine;

    const spaceIdx = line.indexOf(" ");
    const cmdName = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const cmdArgs = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim();

    if (cmdName.startsWith("/")) {
      const command = commands[cmdName];
      if (command) {
        await command.handler(ctx, cmdArgs);
      } else {
        ui.error(
          `Unknown command: ${cmdName}. Type /help for available commands.`,
        );
      }
      continue;
    }

    ctx.messages.push({ role: "user", content: line });
    ui.newline();

    try {
      const loading = ui.spinner("Thinking...");
      let firstToken = true;

      ctx.messages = await runAgent(
        ctx.messages,
        {
          model: ctx.model,
          tools: ctx.tools,
          permissions: ctx.permissions,
          systemPrompt: ctx.config.systemPrompt,
          maxSteps: ctx.config.maxSteps,
          maxTokens: ctx.config.maxTokens,
        },
        {
          onText: (delta) => {
            if (firstToken) {
              loading.stop();
              firstToken = false;
            }
            ui.streamText(delta);
          },

          onToolStart: (name, args) => {
            if (firstToken) {
              loading.stop();
              firstToken = false;
            }
            ui.toolStart(name, args);
          },

          onToolEnd: (name, result) => {
            ui.toolEnd(name, result);
          },

          onUsage: (usage) => {
            ctx.totalUsage.inputTokens += usage.inputTokens;
            ctx.totalUsage.outputTokens += usage.outputTokens;
            ctx.totalUsage.totalTokens += usage.totalTokens;
          },

          onError: (err) => {
            loading.stop();
            ui.error(err);
          },
        },
      );

      if (firstToken) loading.stop();
      ui.newline();
    } catch (e: any) {
      ctx.messages.pop();
      ui.error(e.message);
    }
  }
}
