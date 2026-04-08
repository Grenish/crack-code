import type { ModelMessage, LanguageModel } from "ai";
import * as p from "@clack/prompts";
import { stat } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  fetchModels,
  isSetupCancelledError,
  loadConfig,
  runProviderSetup,
  updateStoredConfig,
  type Config,
} from "./config.js";
import { getModel } from "./providers.js";
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
  input: InputController;
}

interface SlashCommand {
  description: string;
  handler: (ctx: ReplContext, args: string) => void | Promise<void>;
}

interface InputController {
  readLine: () => Promise<string>;
  close: () => void;
  suspend: <T>(task: () => Promise<T>) => Promise<T>;
}

interface PromptMeta {
  cwd: string;
  isHome: boolean;
  modelLabel: string;
  mode: string;
  policy: string;
}

interface ShellMeta {
  gitBranch: string | null;
  host: string;
  osUser: string;
  userHome: string;
}

function unwrapPrompt<T>(value: T | symbol): T | null {
  if (p.isCancel(value)) {
    return null;
  }

  return value as T;
}

async function selectSessionModel(ctx: ReplContext): Promise<string | null> {
  const loading = p.spinner();
  loading.start(`Fetching models for ${ctx.config.provider}...`);

  const models = await fetchModels(ctx.config.provider, ctx.config.apiKey, {
    resourceName: ctx.config.resourceName,
    project: ctx.config.project,
    location: ctx.config.location,
    vertexClientEmail: ctx.config.vertexClientEmail,
    vertexPrivateKey: ctx.config.vertexPrivateKey,
  });

  loading.stop(
    models.length > 0
      ? `Loaded ${Math.min(models.length, 30)} model options`
      : "Model lookup finished",
  );

  if (models.length === 0) {
    const typed = unwrapPrompt(
      await p.text({
        message: `Model for ${ctx.config.provider}`,
        initialValue: ctx.config.model,
        validate: (value) =>
          (value ?? "").trim().length === 0 ? "Model is required." : undefined,
      }),
    );

    return typed ? typed.trim() : null;
  }

  const customValue = "__custom__";
  const selected = unwrapPrompt(
    await p.select({
      message: `Choose a model for ${ctx.config.provider}`,
      options: [
        ...models.slice(0, 30).map((model) => ({
          value: model.id,
          label: model.id,
          hint:
            model.name !== model.id
              ? model.name
              : model.id === ctx.config.model
                ? "current"
                : undefined,
        })),
        {
          value: customValue,
          label: "Enter model manually",
          hint: ctx.config.model === "" ? undefined : `current: ${ctx.config.model}`,
        },
      ],
    }),
  );

  if (!selected) return null;
  if (selected !== customValue) return selected;

  const typed = unwrapPrompt(
    await p.text({
      message: `Model for ${ctx.config.provider}`,
      initialValue: ctx.config.model,
      validate: (value) =>
        (value ?? "").trim().length === 0 ? "Model is required." : undefined,
    }),
  );

  return typed ? typed.trim() : null;
}

function buildRuntimeOverrides(ctx: ReplContext) {
  return {
    allowEdits: ctx.config.allowEdits,
    ignorePatterns: ctx.config.ignorePatterns,
    maxSteps: ctx.config.maxSteps,
    maxTokens: ctx.config.maxTokens,
    permissionPolicy: ctx.permissions.getPolicy(),
    scanPatterns: ctx.config.scanPatterns,
  } satisfies Parameters<typeof loadConfig>[0];
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
    description: "Show or change the active model",
    handler: async (ctx, args) => {
      let nextModel: string | null;

      try {
        nextModel = args
          ? args.trim()
          : await ctx.input.suspend(() => selectSessionModel(ctx));
      } catch (e: any) {
        ui.error(e.message);
        return;
      }

      if (!nextModel) {
        ui.info(`Current model: ${ctx.config.model}`);
        return;
      }

      if (nextModel === ctx.config.model) {
        ui.info(`Model already set to ${nextModel}`);
        return;
      }

      const previousModel = ctx.config.model;
      ctx.config.model = nextModel;

      try {
        ctx.model = getModel(ctx.config);
        await updateStoredConfig({ model: nextModel });
        ui.success(
          `Model changed: ${previousModel} → ${nextModel} (${ctx.config.provider})`,
        );
      } catch (e: any) {
        ctx.config.model = previousModel;
        ctx.model = getModel(ctx.config);
        ui.error(e.message);
      }
    },
  },

  "/provider": {
    description: "Choose a provider and update its credentials/model",
    handler: async (ctx) => {
      try {
        await ctx.input.suspend(async () => {
          await runProviderSetup();
        });
      } catch (e: any) {
        if (isSetupCancelledError(e)) {
          ui.info("Provider setup cancelled.");
          return;
        }
        ui.error(e.message);
        return;
      }

      try {
        const nextConfig = await loadConfig(buildRuntimeOverrides(ctx));
        ctx.config = nextConfig;
        ctx.model = getModel(nextConfig);
        ui.success(
          `Provider configured: ${nextConfig.provider} • model ${nextConfig.model}`,
        );
      } catch (e: any) {
        if (isSetupCancelledError(e)) {
          ui.info("Provider setup cancelled.");
          return;
        }
        ui.error(e.message);
      }
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

async function detectGitBranch(startDir: string): Promise<string | null> {
  let dir = startDir;

  while (true) {
    const dotGit = join(dir, ".git");

    try {
      const dotGitStat = await stat(dotGit);
      let gitDir = dotGit;

      if (dotGitStat.isFile()) {
        const pointer = (await Bun.file(dotGit).text()).trim();
        const match = pointer.match(/^gitdir:\s*(.+)$/i);
        if (!match) return null;
        gitDir = resolve(dir, match[1]!);
      }

      const headFile = Bun.file(join(gitDir, "HEAD"));
      if (!(await headFile.exists())) return null;

      const head = (await headFile.text()).trim();
      const refMatch = head.match(/^ref:\s+refs\/heads\/(.+)$/);
      return refMatch ? refMatch[1]! : head.slice(0, 12);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

async function getShellMeta(cwd: string): Promise<ShellMeta> {
  let osUser = "user";

  try {
    osUser = userInfo().username;
  } catch {
    // keep fallback
  }

  return {
    gitBranch: await detectGitBranch(cwd),
    host: hostname(),
    osUser,
    userHome: homedir(),
  };
}

function formatModelLabel(provider: string, model: string): string {
  return model.includes("/") ? model : `${provider}/${model}`;
}

// Input handling: raw-mode realtime line editor with lightweight hints

function createInput(getPromptMeta: () => PromptMeta): InputController {
  const stdin = process.stdin;
  const stdout = process.stdout;

  const isTTY = Boolean(stdin.isTTY && stdout.isTTY);
  let closed = false;
  let promptVisible = false;

  let pendingResolve: ((line: string) => void) | null = null;
  let line = "";
  let cursor = 0;

  const commandHints = [
    "/help",
    "/clear",
    "/usage",
    "/mode",
    "/model",
    "/provider",
    "/policy",
    "/compact",
    "/exit",
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

  const clearPromptRegion = () => {
    if (!promptVisible || !isTTY) return;

    // Cursor rests on the middle line of the 3-line prompt frame.
    stdout.write("\x1b[1A\r\x1b[2K");
    stdout.write("\x1b[1B\r\x1b[2K");
    stdout.write("\x1b[1B\r\x1b[2K");
    stdout.write("\x1b[2A\r");
  };

  const renderInput = () => {
    if (!pendingResolve || !isTTY) return;

    const commandMode = line.startsWith("/");
    const askMode = line.startsWith("?");
    const promptMeta = getPromptMeta();

    let placeholder = "Describe a scan target, exploit path, or remediation";
    let footer = `Type / for commands • ? quick ask • mode ${promptMeta.mode} • policy ${promptMeta.policy}`;

    if (commandMode) {
      placeholder = "Type a command";

      if (line.trim() === "/") {
        footer = commandHints.join(" • ");
      } else {
        const needle = line.trim().toLowerCase();
        const matches = Object.keys(commands)
          .filter((command) => command.startsWith(needle))
          .slice(0, 6);

        footer =
          matches.length > 0
            ? matches.join(" • ")
            : "No matching command • /help shows all commands";
      }
    } else if (askMode) {
      placeholder = "Ask a short question";
      footer = `Quick ask mode • Enter to send • mode ${promptMeta.mode}`;
    } else if (line.length > 0) {
      footer = `Enter to send • / commands • ? quick ask • mode ${promptMeta.mode} • policy ${promptMeta.policy}`;
    }

    clearPromptRegion();

    const frame = ui.renderPromptFrame({
      cwd: promptMeta.cwd,
      modelLabel: promptMeta.modelLabel,
      input: line,
      cursor,
      placeholder,
      footer,
      isHome: promptMeta.isHome,
    });

    stdout.write(frame.lines.join("\n"));
    stdout.write("\x1b[1A\r");

    if (frame.cursorCol > 0) {
      stdout.write(`\x1b[${frame.cursorCol}C`);
    }

    promptVisible = true;
  };

  const finishLine = (value: string) => {
    const resolve = pendingResolve;
    pendingResolve = null;
    line = "";
    cursor = 0;
    if (promptVisible && isTTY) {
      stdout.write("\x1b[2B\r");
      promptVisible = false;
    }
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

        renderInput();
      }),

    suspend: async <T>(task: () => Promise<T>): Promise<T> => {
      if (!isTTY) {
        return await task();
      }

      if (promptVisible) {
        stdout.write("\x1b[2B\r");
        promptVisible = false;
      }

      stdin.removeListener("data", onData);

      try {
        stdin.setRawMode(false);
      } catch {
        // ignore
      }

      stdin.pause();

      try {
        return await task();
      } finally {
        if (!closed) {
          stdin.setEncoding("utf8");
          stdin.resume();
          stdin.setRawMode(true);
          stdin.on("data", onData);
        }
      }
    },

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
  const shellMeta = await getShellMeta(config.cwd);
  const input = createInput(() => ({
    cwd: config.cwd,
    isHome: config.cwd === shellMeta.userHome,
    modelLabel: formatModelLabel(config.provider, config.model),
    mode: ctx.config.allowEdits ? "edits enabled" : "read-only",
    policy: ctx.permissions.getPolicy(),
  }));
  const ctx: ReplContext = {
    model,
    config,
    tools,
    permissions,
    messages: [],
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    input,
  };

  ui.banner({
    gitBranch: shellMeta.gitBranch,
    host: shellMeta.host,
    osUser: shellMeta.osUser,
    userName: config.userName,
  });

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
