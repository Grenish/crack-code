import { z } from "zod";
import type { ToolDef } from "./registry.js";

const MAX_RESULTS = 500;

const schema = z.object({
  pattern: z
    .string()
    .describe('Glob pattern to match (e.g. "**/*.ts", "src/**/*.js")'),
  ignore: z
    .array(z.string())
    .optional()
    .describe("Additional glob patterns to ignore"),
});

export const listFilesTool: ToolDef<typeof schema> = {
  name: "list_files",
  description:
    "List files matching a glob pattern in the working directory. " +
    "Common ignore patterns (node_modules, .git, dist, etc.) are excluded by default. " +
    "Returns up to 500 matching paths sorted alphabetically.",
  inputSchema: schema,
  requiresApproval: false,

  async execute({ pattern, ignore }) {
    const cwd = process.cwd();

    const defaultIgnore = [
      "node_modules/**",
      ".git/**",
      "dist/**",
      "build/**",
      "coverage/**",
      ".next/**",
      "__pycache__/**",
      "vendor/**",
      "target/**",
    ];

    const ignorePatterns = [...defaultIgnore, ...(ignore ?? [])];

    const glob = new Bun.Glob(pattern);
    const matches: string[] = [];

    for await (const path of glob.scan({ cwd, dot: false })) {
      if (shouldIgnore(path, ignorePatterns)) continue;
      matches.push(path);
      if (matches.length >= MAX_RESULTS) break;
    }

    matches.sort();

    if (matches.length === 0) {
      return `No files matched pattern "${pattern}"`;
    }

    const header =
      matches.length >= MAX_RESULTS
        ? `Found ${MAX_RESULTS}+ files (showing first ${MAX_RESULTS}):`
        : `Found ${matches.length} file${matches.length === 1 ? "" : "s"}:`;

    return `${header}\n\n${matches.join("\n")}`;
  },
};

function shouldIgnore(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Simple prefix match for directory globs like "node_modules/**"
    if (pattern.endsWith("/**")) {
      const dir = pattern.slice(0, -3);
      if (path === dir || path.startsWith(dir + "/")) return true;
    }

    // Simple extension match for patterns like "*.lock"
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      if (path.endsWith(ext)) return true;
    }

    // Exact match
    if (path === pattern) return true;
  }
  return false;
}
