import { z } from "zod";
import type { ToolDef } from "./registry.js";

const DEFAULT_TIMEOUT = 30_000; // 30 seconds
const MAX_OUTPUT = 128 * 1024; // 128 KB

const schema = z.object({
  command: z.string().describe("The shell command to execute"),
  timeout_ms: z
    .number()
    .optional()
    .describe("Max runtime in milliseconds (default 30000)"),
});

export const runCommandTool: ToolDef<typeof schema> = {
  name: "run_command",
  description:
    "Execute a shell command in the working directory. " +
    "Output is captured from stdout and stderr. " +
    "Commands are killed after the timeout (default 30s). " +
    "Always requires user approval.",
  inputSchema: schema,
  requiresApproval: true,

  async execute({ command, timeout_ms }) {
    const timeout = timeout_ms ?? DEFAULT_TIMEOUT;
    const cwd = process.cwd();

    try {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
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

      return parts.join("\n\n");
    } catch (err: any) {
      if (err.message?.includes("kill")) {
        return `Error: command timed out after ${timeout}ms — "${command}"`;
      }
      return `Error: ${err.message ?? err}`;
    }
  },
};
