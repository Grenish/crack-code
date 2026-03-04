import { z } from "zod";
import { resolve, relative, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ToolDef } from "./registry.js";

const schema = z.object({
  path: z.string().describe("Relative or absolute path to the file"),
  content: z.string().describe("The full content to write to the file"),
});

export const writeFileTool: ToolDef<typeof schema> = {
  name: "write_file",
  description:
    "Write content to a file. Creates the file if it doesn't exist, " +
    "overwrites if it does. Parent directories are created automatically. " +
    "Always requires user approval.",
  inputSchema: schema,
  requiresApproval: true,

  async execute({ path: filePath, content }) {
    const cwd = process.cwd();
    const abs = resolve(cwd, filePath);
    const rel = relative(cwd, abs);

    // Block path traversal outside cwd
    if (rel.startsWith("..")) {
      return `Error: path "${filePath}" is outside the working directory.`;
    }

    // Ensure parent directories exist
    await mkdir(dirname(abs), { recursive: true });

    const existed = await Bun.file(abs).exists();
    await Bun.write(abs, content);

    const lines = content.split("\n").length;
    const bytes = Buffer.byteLength(content, "utf-8");
    const action = existed ? "Updated" : "Created";

    return `${action} ${rel} (${lines} lines, ${bytes} bytes)`;
  },
};
