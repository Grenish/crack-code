import * as readline from "node:readline";
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

// Slash Commands

interface SlashCommand {
  description: string;
  handler: (ctx: ReplContext, args: string) => void | Promise<void>;
}

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

      // Keep the last exchange, summarize everything before it
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

// Input Handling

function createInput(): {
  readLine: () => Promise<string>;
  close: () => void;
} {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Handle Ctrl+C gracefully
  rl.on("SIGINT", () => {
    console.log();
    ui.info("Goodbye.");
    process.exit(0);
  });

  return {
    readLine: () =>
      new Promise<string>((resolve) => {
        ui.userPrompt();
        rl.once("line", (line) => resolve(line.trim()));
      }),
    close: () => rl.close(),
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
  ui.banner(config.model, mode);

  const input = createInput();

  while (true) {
    const line = await input.readLine();

    if (!line) continue;

    // Slash command
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

    // Send to agent
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

      // If spinner never stopped (empty response), stop it now
      if (firstToken) loading.stop();

      ui.newline();
    } catch (e: any) {
      // Agent threw — keep previous messages intact
      ctx.messages.pop(); // remove the user message that caused the error
      ui.error(e.message);
    }
  }
}
