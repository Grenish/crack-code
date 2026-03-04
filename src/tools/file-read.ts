import { z } from "zod";
import { resolve, relative } from "node:path";
import type { ToolDef } from "./registry.js";

const MAX_SIZE = 256 * 1024; // 256 KB

const schema = z.object({
  path: z.string().describe("Relative or absolute path to the file"),
  start_line: z.number().optional().describe("First line to read (1-based)"),
  end_line: z
    .number()
    .optional()
    .describe("Last line to read (1-based, inclusive)"),
});

export const readFileTool: ToolDef<typeof schema> = {
  name: "read_file",
  description:
    "Read the contents of a file. Returns numbered lines. " +
    "Use start_line/end_line to read a specific range. " +
    "Files larger than 256 KB are truncated.",
  inputSchema: schema,
  requiresApproval: false,

  async execute({ path: filePath, start_line, end_line }) {
    const cwd = process.cwd();
    const abs = resolve(cwd, filePath);
    const rel = relative(cwd, abs);

    // Block path traversal outside cwd
    if (rel.startsWith("..")) {
      return `Error: path "${filePath}" is outside the working directory.`;
    }

    const file = Bun.file(abs);
    if (!(await file.exists())) {
      return `Error: file not found — ${rel}`;
    }

    const size = file.size;
    if (size > MAX_SIZE) {
      const partial = await file.text();
      const truncated = partial.slice(0, MAX_SIZE);
      const lines = truncated.split("\n");
      return (
        `⚠ File truncated (${(size / 1024).toFixed(0)} KB > 256 KB limit). Showing first ${lines.length} lines.\n\n` +
        numberLines(lines, 1)
      );
    }

    const content = await file.text();
    let lines = content.split("\n");

    // Apply line range
    const start = start_line ? Math.max(1, start_line) : 1;
    const end = end_line ? Math.min(lines.length, end_line) : lines.length;
    lines = lines.slice(start - 1, end);

    if (lines.length === 0) {
      return `File is empty — ${rel}`;
    }

    const header =
      start_line || end_line
        ? `${rel} (lines ${start}–${end})`
        : `${rel} (${lines.length} lines)`;

    return `${header}\n\n${numberLines(lines, start)}`;
  },
};

function numberLines(lines: string[], startAt: number): string {
  const width = String(startAt + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startAt + i).padStart(width)} │ ${line}`)
    .join("\n");
}
