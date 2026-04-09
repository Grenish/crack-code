import type { ModelMessage, LanguageModel } from "ai";
import * as p from "@clack/prompts";
import { stat } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  fetchModels,
  isSetupCancelledError,
  loadConfig,
  runProviderSetup,
  updateStoredConfig,
  type Config,
} from "./config.js";
import { getModel, buildProviderOptions } from "./providers.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { PermissionManager } from "./permissions/index.js";
import { runAgent, type TokenUsage } from "./agent.js";
import * as ui from "./ui/renderer.js";
import { launchMarketplaceHub } from "./marketplace/tui.js";
import type { ToolPackage, InstalledTool } from "./marketplace/types.js";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

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
  userHome: string;
  provider: string;
  model: string;
  modelLabel: string;
  gitBranch: string | null;
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
          hint:
            ctx.config.model === ""
              ? undefined
              : `current: ${ctx.config.model}`,
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

const LOGO_PATH = resolve(homedir(), ".crack-code", "config.json");
const DEFAULT_LOGO_PATH = resolve(__dirname, "./logo/logo.md");

async function readLogoFromConfig(): Promise<string | null> {
  try {
    const raw = await readFile(LOGO_PATH, "utf-8");
    const parsed = JSON.parse(raw) as {
      logo?: string;
      useDefaultLogo?: boolean;
    };

    if (parsed.useDefaultLogo) return null;

    const logo = parsed.logo?.trim();
    return logo ? logo : null;
  } catch {
    return null;
  }
}

function readDefaultLogo(): string {
  return readFileSync(DEFAULT_LOGO_PATH, "utf-8");
}

async function writeLogoToConfig(logo: string | null): Promise<void> {
  try {
    const raw = await readFile(LOGO_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next = {
      ...parsed,
      ...(logo === null
        ? { logo: undefined, useDefaultLogo: true }
        : { logo, useDefaultLogo: false }),
    };

    if (logo === null) {
      delete next.logo;
    }

    await writeFile(LOGO_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
  } catch {
    await writeFile(
      LOGO_PATH,
      JSON.stringify(
        logo === null
          ? { useDefaultLogo: true }
          : { logo, useDefaultLogo: false },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
  }
}

async function editLogoInNvimLikePage(ctx: ReplContext): Promise<void> {
  const current = (await readLogoFromConfig()) ?? readDefaultLogo();
  console.log();
  ui.dim("Opening logo editor...");
  console.log(current);
  console.log();
  const next = unwrapPrompt(
    await p.text({
      message: "Edit logo markdown",
      initialValue: current,
      validate: (value) =>
        (value ?? "").trim().length === 0 ? "Logo cannot be empty." : undefined,
    }),
  );

  if (!next) return;

  await updateStoredConfig({ logo: next });
  ui.success("Logo updated.");
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

  "/logo": {
    description: "Edit the current logo",
    handler: async (ctx) => {
      try {
        await ctx.input.suspend(async () => {
          await editLogoInNvimLikePage(ctx);
        });
      } catch (e: any) {
        ui.error(e.message);
      }
    },
  },

  "/def-logo": {
    description: "Reset to the default logo",
    handler: async (ctx) => {
      try {
        await updateStoredConfig({ logo: undefined });
        ui.success("Logo reset to default.");
      } catch (e: any) {
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

  "/marketplace": {
    description: "Open the community tool marketplace",
    handler: async (ctx) => {
      // Mock data for Phase 1
      const mockPackages: ToolPackage[] = [
        {
          id: "auth-checker",
          name: "Auth Checker",
          version: "1.0.0",
          description: "Scan for common authentication vulnerabilities",
          author: "Crack Code Team",
          license: "MIT",
          downloads: 156,
          rating: 4.5,
          tags: ["security", "auth"],
          main: "./dist/index.ts",
          tools: [
            {
              id: "check_auth_flaws",
              name: "Check Auth Flaws",
              description: "Detect authentication issues",
              schema: {},
            },
          ],
          permissions: {
            requiresFileWrite: false,
            requiresShellAccess: false,
          },
        },
        {
          id: "sql-injection-detector",
          name: "SQL Injection Detector",
          version: "2.1.3",
          description: "Identify SQL injection vulnerabilities",
          author: "Security Labs",
          license: "MIT",
          downloads: 342,
          rating: 4.8,
          tags: ["security", "sql"],
          main: "./dist/index.ts",
          tools: [
            {
              id: "detect_sql_injection",
              name: "Detect SQL Injection",
              description: "Find SQL injection risks",
              schema: {},
            },
          ],
          permissions: {
            requiresFileWrite: false,
            requiresShellAccess: false,
          },
        },
        {
          id: "xss-scanner",
          name: "XSS Scanner",
          version: "1.5.2",
          description: "Detect cross-site scripting vulnerabilities",
          author: "Security Labs",
          license: "MIT",
          downloads: 289,
          rating: 4.6,
          tags: ["security", "xss", "web"],
          main: "./dist/index.ts",
          tools: [
            {
              id: "scan_xss",
              name: "Scan XSS",
              description: "Find XSS vulnerabilities",
              schema: {},
            },
          ],
          permissions: {
            requiresFileWrite: false,
            requiresShellAccess: false,
          },
        },
      ];

      const mockInstalledTools: InstalledTool[] = [];

      await launchMarketplaceHub(mockPackages, mockInstalledTools);
      ui.success("Returned to REPL.");
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

function formatPromptPath(cwd: string, homeDir: string): string {
  if (cwd === homeDir) return "~";
  if (cwd.startsWith(`${homeDir}/`)) {
    return `~/${cwd.slice(homeDir.length + 1)}`;
  }

  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return cwd;
  return `…/${parts.slice(-2).join("/")}`;
}

function padLines(lines: string[], totalRows: number): string[] {
  if (lines.length >= totalRows) return lines;
  return [...lines, ...Array.from({ length: totalRows - lines.length }, () => "")];
}

function isTrustedCodebase(cwd: string, trusted: string[] | undefined): boolean {
  if (!trusted || trusted.length === 0) return false;
  const normalized = resolve(cwd);
  for (const base of trusted) {
    const b = resolve(base);
    if (normalized === b) return true;
    if (normalized.startsWith(b + sep)) return true;
  }
  return false;
}

type TrustChoice = "session" | "parent" | "no";

async function promptTrustCodebase(cwd: string): Promise<TrustChoice> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "no";

  const parent = dirname(resolve(cwd));
  const choice = await p.select({
    message: `Trust this directory for indexing and @ file mentions? (${cwd})`,
    options: [
      {
        value: "session",
        label: "Trust for this session",
        hint: "Enables indexing now; nothing is saved",
      },
      {
        value: "parent",
        label: "Trust parent permanently",
        hint: `Saves ${parent} to config`,
      },
      { value: "no", label: "Do not trust", hint: "No indexing" },
    ],
    initialValue: "session",
  });

  if (p.isCancel(choice)) return "no";
  return choice as TrustChoice;
}

function shouldIgnore(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith("/**")) {
      const dir = pattern.slice(0, -3);
      if (path === dir || path.startsWith(dir + "/")) return true;
    }

    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      if (path.endsWith(ext)) return true;
    }

    if (path === pattern) return true;
  }
  return false;
}

async function indexCodebaseFiles(
  cwd: string,
  ignorePatterns: string[],
): Promise<string[]> {
  const glob = new Bun.Glob("**/*");
  const out: string[] = [];
  const seen = new Set<string>();

  for await (const rel of glob.scan({ cwd, dot: false })) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (shouldIgnore(rel, ignorePatterns)) continue;

    try {
      const st = await stat(join(cwd, rel));
      if (!st.isFile()) continue;
    } catch {
      continue;
    }

    out.push(rel);
    if (out.length >= 5000) break;
  }

  out.sort();
  return out;
}

// Input handling: raw-mode realtime line editor with lightweight hints

function createInput(
  getPromptMeta: () => PromptMeta,
  getFileIndex: () => string[],
  isTrustedSession: () => boolean,
  isResponseActive: () => boolean,
  interruptResponse: () => boolean,
): InputController {
  const stdin = process.stdin;
  const stdout = process.stdout;

  const isTTY = Boolean(stdin.isTTY && stdout.isTTY);
  let closed = false;
  let promptVisible = false;
  let promptLineCount = 0;
  let promptCursorRow = 1;

  let pendingResolve: ((line: string) => void) | null = null;
  let line = "";
  let cursor = 0;
  let slashSelection = 0;
  let slashSelectionQuery = "";
  let atSelection = 0;
  let atSelectionQuery = "";

  const commandHints = [
    "/help",
    "/clear",
    "/marketplace",
    "/usage",
    "/mode",
    "/model",
    "/provider",
    "/logo",
    "/def-logo",
    "/policy",
    "/compact",
    "/exit",
  ];
  const commandEntries = commandHints.map((name) => ({
    name,
    description: commands[name]?.description ?? "",
  }));

  const syncSlashSelection = (query: string, count: number) => {
    if (query !== slashSelectionQuery) {
      slashSelectionQuery = query;
      slashSelection = 0;
    }

    if (count === 0) {
      slashSelection = 0;
      return;
    }

    if (slashSelection >= count) {
      slashSelection = count - 1;
    }
  };

  const getSlashMenuState = () => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) return null;

    const spaceIndex = trimmed.indexOf(" ");
    const query = (
      spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)
    ).toLowerCase();
    const hasArgs = spaceIndex !== -1;
    const entries = commandEntries
      .filter((entry) => entry.name.startsWith(query))
      .sort((a, b) => {
        if (query === "/") {
          return commandHints.indexOf(a.name) - commandHints.indexOf(b.name);
        }

        return (
          a.name.length - b.name.length ||
          commandHints.indexOf(a.name) - commandHints.indexOf(b.name)
        );
      })
      .slice(0, 8);

    return { query, hasArgs, entries };
  };

  const applySelectedSlashCommand = (): boolean => {
    const menu = getSlashMenuState();
    if (!menu || menu.hasArgs || menu.entries.length === 0) return false;

    const selected = menu.entries[slashSelection]?.name;
    if (!selected) return false;

    line = selected;
    cursor = line.length;
    return true;
  };

  const getCurrentToken = () => {
    const beforeCursor = line.slice(0, cursor);
    const tokenStart = beforeCursor.lastIndexOf(" ") + 1;
    const token = line.slice(tokenStart, cursor);
    return { tokenStart, token };
  };

  const syncAtSelection = (query: string, count: number) => {
    if (query !== atSelectionQuery) {
      atSelectionQuery = query;
      atSelection = 0;
    }

    if (count === 0) {
      atSelection = 0;
      return;
    }

    if (atSelection >= count) {
      atSelection = count - 1;
    }
  };

  const getAtMenuState = () => {
    const { tokenStart, token } = getCurrentToken();
    if (!token.startsWith("@")) return null;

    const query = token.slice(1);
    const fileIndex = getFileIndex();
    if (!isTrustedSession() || fileIndex.length === 0) {
      return { tokenStart, query, entries: [] as string[], blocked: true };
    }

    const needle = query.toLowerCase();
    const entries = fileIndex
      .filter((p) => p.toLowerCase().includes(needle))
      .sort((a, b) => {
        const ap = a.toLowerCase().startsWith(needle) ? 0 : 1;
        const bp = b.toLowerCase().startsWith(needle) ? 0 : 1;
        return ap - bp || a.length - b.length || a.localeCompare(b);
      })
      .slice(0, 8);

    return { tokenStart, query, entries, blocked: false };
  };

  const applySelectedAtMention = (picked?: string): boolean => {
    const menu = getAtMenuState();
    if (!menu || menu.blocked) return false;

    const selected = picked ?? menu.entries[atSelection];
    if (!selected) return false;

    const before = line.slice(0, menu.tokenStart);
    const after = line.slice(cursor);
    line = `${before}@${selected}${after}`;
    cursor = (before + "@" + selected).length;
    return true;
  };

  const getCurrentSlashToken = () => {
    const beforeCursor = line.slice(0, cursor);
    const tokenStart = beforeCursor.lastIndexOf(" ") + 1;
    const token = line.slice(tokenStart, cursor);

    if (!token.startsWith("/")) {
      return null;
    }

    return { tokenStart, token };
  };

  const getClosestSlashCommand = (token: string): string | null => {
    const needle = token.toLowerCase();

    // Prefer prefix matches first.
    const prefixMatch = commandHints.find((command) =>
      command.toLowerCase().startsWith(needle),
    );
    if (prefixMatch) return prefixMatch;

    // Fallback: closest command by Levenshtein distance.
    const distance = (a: string, b: string): number => {
      const rows = a.length + 1;
      const cols = b.length + 1;
      const dp: number[][] = Array.from({ length: rows }, () =>
        Array(cols).fill(0),
      );

      for (let i = 0; i < rows; i++) dp[i]![0] = i;
      for (let j = 0; j < cols; j++) dp[0]![j] = j;

      for (let i = 1; i < rows; i++) {
        for (let j = 1; j < cols; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          dp[i]![j] = Math.min(
            dp[i - 1]![j]! + 1, // deletion
            dp[i]![j - 1]! + 1, // insertion
            dp[i - 1]![j - 1]! + cost, // substitution
          );
        }
      }

      return dp[rows - 1]![cols - 1]!;
    };

    let best: { command: string; score: number } | null = null;
    for (const command of commandHints) {
      const score = distance(needle, command.toLowerCase());
      if (!best || score < best.score) {
        best = { command, score };
      }
    }

    return best?.command ?? null;
  };

  const applySlashAutocomplete = (): boolean => {
    if (applySelectedSlashCommand()) {
      return true;
    }

    const slashToken = getCurrentSlashToken();
    if (!slashToken) return false;

    const completion = getClosestSlashCommand(slashToken.token);
    if (!completion || completion === slashToken.token) return false;

    line =
      line.slice(0, slashToken.tokenStart) + completion + line.slice(cursor);
    cursor = slashToken.tokenStart + completion.length;
    return true;
  };

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

  const buildMoveCursorBelowPrompt = () => {
    let output = "";
    if (!promptVisible || !isTTY) return output;

    const down = Math.max(0, promptLineCount - promptCursorRow - 1);
    if (down > 0) {
      output += `\x1b[${down}B`;
    }
    output += "\r";
    return output;
  };

  const moveCursorBelowPrompt = () => {
    if (!promptVisible || !isTTY) return;
    stdout.write(buildMoveCursorBelowPrompt());
    promptVisible = false;
  };

  const buildClearPromptRegion = () => {
    if (!promptVisible || !isTTY) return "";

    let output = "";

    if (promptCursorRow > 0) {
      output += `\x1b[${promptCursorRow}A`;
    }
    output += "\r";

    for (let i = 0; i < promptLineCount; i++) {
      output += "\x1b[2K";
      if (i < promptLineCount - 1) {
        output += "\x1b[1B\r";
      }
    }

    if (promptLineCount > 1) {
      output += `\x1b[${promptLineCount - 1}A`;
    }
    output += "\r";
    return output;
  };

  const renderInput = () => {
    if (!pendingResolve || !isTTY) return;

    const commandMode = line.startsWith("/");
    const askMode = line.startsWith("?");
    const promptMeta = getPromptMeta();
    const promptPath = formatPromptPath(promptMeta.cwd, promptMeta.userHome);
    const sessionMeta = promptMeta.gitBranch
      ? `${promptMeta.provider} | ${promptMeta.model} | ${promptPath} > ${promptMeta.gitBranch}`
      : `${promptMeta.provider} | ${promptMeta.model} | ${promptPath}`;
    const slashMenu = getSlashMenuState();
    const atMenu = getAtMenuState();

    if (slashMenu) {
      syncSlashSelection(slashMenu.query, slashMenu.entries.length);
    } else {
      slashSelectionQuery = "";
      slashSelection = 0;
    }
    if (atMenu) {
      syncAtSelection(atMenu.query, atMenu.entries.length);
    } else {
      atSelectionQuery = "";
      atSelection = 0;
    }

    let placeholder = "Describe a scan target, exploit path, or remediation";
    let footerLines = [sessionMeta];

    if (commandMode) {
      placeholder = "Type a command";

      if (slashMenu && !slashMenu.hasArgs) {
        if (slashMenu.entries.length > 0) {
          footerLines = padLines(
            [
              ...slashMenu.entries.map((entry, index) => {
                const marker = index === slashSelection ? ">" : " ";
                return `${marker} ${entry.name.padEnd(14)} ${entry.description}`;
              }),
              "↑↓ to choose | Tab to complete | Enter to select",
            ],
            9,
          );
        } else {
          footerLines = padLines(
            [
              "No matching command",
              "Tab completes the closest command | /help shows all commands",
            ],
            9,
          );
        }
      } else {
        const commandName = line.trim().split(/\s+/, 1)[0] ?? "";
        const description = commands[commandName]?.description ?? "Run command";
        footerLines = [`${commandName} | ${description}`, sessionMeta];
      }
    } else if (askMode) {
      placeholder = "Ask a short question";
      footerLines = [`quick ask | ${sessionMeta}`];
    } else if (atMenu) {
      if (atMenu.blocked) {
        footerLines = padLines(
          ["Untrusted directory: @ file picker is disabled", sessionMeta],
          9,
        );
      } else if (atMenu.entries.length > 0) {
        footerLines = padLines(
          [
            ...atMenu.entries.map((entry, index) => {
              const marker = index === atSelection ? ">" : " ";
              return `${marker} @${entry}`;
            }),
            "↑↓ to choose | Tab to pick | Enter to select",
          ],
          9,
        );
      } else {
        footerLines = padLines(["No matching files", sessionMeta], 9);
      }
    }

    const frame = ui.renderPromptFrame({
      cwd: promptMeta.cwd,
      modelLabel: promptMeta.modelLabel,
      input: line,
      cursor,
      placeholder,
      footerLines,
      isHome: promptMeta.isHome,
    });

    let output = "";
    output += buildClearPromptRegion();
    output += frame.lines.join("\n");
    promptLineCount = frame.lines.length;
    promptCursorRow = frame.cursorRow;

    const rowsUp = Math.max(0, frame.lines.length - frame.cursorRow - 1);
    if (rowsUp > 0) {
      output += `\x1b[${rowsUp}A`;
    }
    output += "\r";

    if (frame.cursorCol > 0) {
      output += `\x1b[${frame.cursorCol}C`;
    }

    stdout.write(output);
    promptVisible = true;
  };

  const suspendInteractive = async <T>(task: () => Promise<T>): Promise<T> => {
    if (!isTTY) {
      return await task();
    }

    if (promptVisible) {
      moveCursorBelowPrompt();
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
        try {
          stdin.setRawMode(true);
        } catch {
          // ignore
        }
        stdin.on("data", onData);
        renderInput();
      }
    }
  };

  const finishLine = (value: string) => {
    const resolve = pendingResolve;
    pendingResolve = null;
    line = "";
    cursor = 0;
    moveCursorBelowPrompt();
    resolve?.(value.trim());
  };

  function onData(chunk: Buffer | string) {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");

    if (!pendingResolve) {
      if (isResponseActive() && s.includes("\u001b")) {
        interruptResponse();
      }
      return;
    }

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
        const atMenu = getAtMenuState();
        if (atMenu && !atMenu.blocked && atMenu.entries.length > 0) {
          const token = getCurrentToken().token;
          const selected = atMenu.entries[atSelection];
          const selectedToken = selected ? `@${selected}` : null;
          if (selectedToken && token !== selectedToken) {
            if (applySelectedAtMention()) {
              renderInput();
            }
            return;
          }
        }

        const slashMenu = getSlashMenuState();
        if (
          slashMenu &&
          !slashMenu.hasArgs &&
          slashMenu.entries.length > 0 &&
          line.trim() !== slashMenu.entries[slashSelection]?.name
        ) {
          if (applySelectedSlashCommand()) {
            renderInput();
          }
          return;
        }

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

      // Tab autocomplete for slash commands
      if (ch === "\t") {
        const atMenu = getAtMenuState();
        if (atMenu && !atMenu.blocked) {
          const fileIndex = getFileIndex();
          if (fileIndex.length > 0) {
            if (atMenu.query.length > 0) {
              if (applySelectedAtMention()) {
                renderInput();
              }
              continue;
            }

            void suspendInteractive(async () => {
              const choice = await p.autocomplete({
                message: "Pick a file to mention",
                options: fileIndex.map((value) => ({ value, label: value })),
              });

              if (p.isCancel(choice)) return;
              applySelectedAtMention(choice as string);
            });
            return;
          }
        }

        if (applySlashAutocomplete()) {
          renderInput();
        }
        continue;
      }

      // ESC sequences (arrows)
      if (ch === "\u001b") {
        const next1 = s[i + 1];
        const next2 = s[i + 2];
        if (next1 === "[") {
          if (next2 === "A" || next2 === "B") {
            const atMenu = getAtMenuState();
            if (atMenu && !atMenu.blocked && atMenu.entries.length > 0) {
              const delta = next2 === "A" ? -1 : 1;
              atSelection =
                (atSelection + delta + atMenu.entries.length) %
                atMenu.entries.length;
              i += 2;
              renderInput();
              continue;
            }

            const slashMenu = getSlashMenuState();
            if (
              slashMenu &&
              !slashMenu.hasArgs &&
              slashMenu.entries.length > 0
            ) {
              const delta = next2 === "A" ? -1 : 1;
              slashSelection =
                (slashSelection + delta + slashMenu.entries.length) %
                slashMenu.entries.length;
              i += 2;
              renderInput();
              continue;
            }
          }
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
  }

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

    suspend: suspendInteractive,

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

  const alreadyTrusted = isTrustedCodebase(
    config.cwd,
    config.trustedCodebases,
  );
  let trustedThisSession = alreadyTrusted;
  let fileIndex: string[] = [];

  if (!alreadyTrusted) {
    const choice = await promptTrustCodebase(config.cwd);
    if (choice === "session") {
      trustedThisSession = true;
    } else if (choice === "parent") {
      trustedThisSession = true;
      const parent = dirname(resolve(config.cwd));
      const existing = config.trustedCodebases ?? [];
      const next = Array.from(new Set([...existing, parent]));
      await updateStoredConfig({ trustedCodebases: next });
      config.trustedCodebases = next;
    }
  }

  if (trustedThisSession) {
    const loading = p.spinner();
    loading.start("Indexing codebase for @ mentions...");
    try {
      fileIndex = await indexCodebaseFiles(config.cwd, config.ignorePatterns);
      loading.stop(
        fileIndex.length >= 5000
          ? "Indexed 5000+ files"
          : `Indexed ${fileIndex.length} files`,
      );
    } catch (e: any) {
      loading.stop("Indexing skipped");
      ui.warn(`Indexing failed: ${e?.message ?? "unknown error"}`);
    }
  }

  let activeResponseAbortController: AbortController | null = null;
  let ctx!: ReplContext;
  const input = createInput(
    () => ({
      cwd: config.cwd,
      isHome: config.cwd === shellMeta.userHome,
      userHome: shellMeta.userHome,
      provider: ctx.config.provider,
      model: ctx.config.model,
      modelLabel: formatModelLabel(ctx.config.provider, ctx.config.model),
      gitBranch: shellMeta.gitBranch,
    }),
    () => fileIndex,
    () => trustedThisSession,
    () => activeResponseAbortController !== null,
    () => {
      if (!activeResponseAbortController) return false;
      activeResponseAbortController.abort(new Error("Response interrupted."));
      return true;
    },
  );

  ctx = {
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

    let loading = ui.spinner("Thinking...");
    try {
      const responseAbortController = new AbortController();
      activeResponseAbortController = responseAbortController;
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
          providerOptions: buildProviderOptions(ctx.config),
          abortSignal: responseAbortController.signal,
        },
        {
          onReasoning: (delta) => {
            if (firstToken) {
              loading.stop();
              firstToken = false;
              console.log("\x1b[2m🤔 Thinking...\x1b[0m");
            }
            ui.streamReasoning(delta);
          },
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
      loading.stop();
      if (activeResponseAbortController?.signal.aborted) {
        ui.newline();
        ui.warn("Response interrupted.");
      } else {
        ctx.messages.pop();
        ui.error(e.message);
      }
    } finally {
      activeResponseAbortController = null;
    }
  }
}
