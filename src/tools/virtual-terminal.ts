import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { getGlobalTerminal } from "./virtual-terminal-state.js";

const DEFAULT_TIMEOUT = 30_000; // 30 seconds
const MAX_OUTPUT = 128 * 1024; // 128 KB

const schema = z.object({
  command: z.string().describe("The shell command to execute in the virtual terminal"),
  timeout_ms: z
    .number()
    .optional()
    .describe("Max runtime in milliseconds (default 30000)"),
});

export const virtualTerminalTool: ToolDef<typeof schema> = {
  name: "virtual_terminal",
  description:
    "Execute a shell command in a persistent virtual terminal. " +
    "The working directory and environment variables are maintained across invocations. " +
    "Built-in commands: 'cd <path>', 'pwd', 'env', 'env KEY=VALUE', 'unset KEY', 'history' " +
    "Output is captured from stdout and stderr. " +
    "Commands are killed after the timeout (default 30s). " +
    "Always requires user approval.",
  inputSchema: schema,
  requiresApproval: true,

  async execute({ command, timeout_ms }) {
    const timeout = timeout_ms ?? DEFAULT_TIMEOUT;
    const terminal = getGlobalTerminal();

    // Add to history
    terminal.addToHistory(command);

    // Handle special built-in commands
    if (command.startsWith("cd ")) {
      const path = command.slice(3).trim();
      const result = terminal.changeDir(path);
      if (result.success) {
        return `Changed directory to: ${result.newCwd}`;
      } else {
        return `Error: ${result.error}`;
      }
    }

    if (command === "pwd") {
      return terminal.getCwd();
    }

    if (command === "env") {
      const env = terminal.getEnv();
      const lines = Object.entries(env)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => `${k}=${v}`);
      return lines.join("\n");
    }

    if (command.startsWith("env ")) {
      const assignment = command.slice(4).trim();
      const eqIndex = assignment.indexOf("=");
      if (eqIndex === -1) {
        return `Error: invalid env assignment. Use 'env KEY=VALUE'`;
      }
      const key = assignment.slice(0, eqIndex);
      const value = assignment.slice(eqIndex + 1);
      terminal.setEnv(key, value);
      return `Set ${key}=${value}`;
    }

    if (command.startsWith("unset ")) {
      const key = command.slice(6).trim();
      const deleted = terminal.deleteEnv(key);
      if (deleted) {
        return `Unset ${key}`;
      } else {
        return `Error: variable ${key} not found`;
      }
    }

    if (command === "history") {
      const hist = terminal.getRecentHistory(20);
      if (hist.length === 0) {
        return "No history";
      }
      return hist.map((cmd, i) => `${i + 1}  ${cmd}`).join("\n");
    }

    if (command === "history clear") {
      terminal.clearHistory();
      return "History cleared";
    }

    // Execute regular shell command
    const cwd = terminal.getCwd();
    const env = terminal.getEnv();

    try {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env,
      });

      const timer = setTimeout(() => proc.kill(), timeout);

      const [stdoutBuf, stderrBuf] = await Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).arrayBuffer(),
      ]);

      clearTimeout(timer);

      const code = proc.exitCode ?? (await proc.exited);
      let stdout = new TextDecoder().decode(stdoutBuf);
      let stderr = new TextDecoder().decode(stderrBuf);

      // Truncate if too large
      if (stdout.length > MAX_OUTPUT) {
        stdout = stdout.slice(0, MAX_OUTPUT) + "\n… (stdout truncated)";
      }
      if (stderr.length > MAX_OUTPUT) {
        stderr = stderr.slice(0, MAX_OUTPUT) + "\n… (stderr truncated)";
      }

      const parts: string[] = [`Exit code: ${code}`];
      if (stdout.trim()) parts.push(`stdout:\n${stdout.trim()}`);
      if (stderr.trim()) parts.push(`stderr:\n${stderr.trim()}`);

      return parts.join("\n");
    } catch (err: any) {
      if (err.message?.includes("kill")) {
        return `Error: command timed out after ${timeout}ms — "${command}"`;
      }
      return `Error: ${err.message ?? err}`;
    }
  },
};
