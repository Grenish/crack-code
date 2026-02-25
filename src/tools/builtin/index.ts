// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Built-in Tools
// ─────────────────────────────────────────────────────────────────────────────
// Defines and implements the 5 built-in tools that the AI agent can invoke
// during analysis:
//
//   1. browse_dir     — List contents of a directory
//   2. browse_file    — Read a file's content (or specific lines)
//   3. find_file_or_folder — Search for files/folders by name pattern
//   4. search_online  — Web search via MCP (if configured)
//   5. call_mcp       — Generic MCP server call
//
// Each tool is defined with a JSON Schema for its parameters (sent to the
// AI model) and an execute() function that performs the actual operation.
//
// All tools are strictly READ-ONLY. No tool may modify, create, or delete
// any file in the user's codebase.
//
// Zero external dependencies — built on Node built-ins and project utils.
// ─────────────────────────────────────────────────────────────────────────────

import { resolve, relative, basename, join } from "node:path";

import { FOLDER_ICON, FILE_ICON, WARNING_MARK } from "../../utils/colors.js";

import type {
  ToolDefinition,
  ToolParametersSchema,
} from "../../providers/base.js";

import {
  listDirectory,
  safeReadFile,
  readFileLines,
  findFiles,
  exists,
  isDirectory,
  isFile,
  formatBytes,
  type DirEntry,
} from "../../utils/fs.js";

import {
  BUILTIN_TOOLS,
  MAX_FILE_SIZE_BYTES,
  MAX_LINES_PER_FILE,
  type BuiltinTool,
} from "../../utils/constants.js";

import { appendAuditLog } from "../../config/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Result of executing a built-in tool.
 */
export interface ToolExecutionResult {
  /** Whether the tool executed successfully */
  success: boolean;
  /** The tool's output content (returned to the AI model) */
  content: string;
  /** Error message if the tool failed */
  error?: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Optional metadata about what was accessed */
  metadata?: Record<string, unknown>;
}

/**
 * A fully-defined built-in tool with its schema and executor.
 */
export interface BuiltinToolEntry {
  /** Tool name (must match BUILTIN_TOOLS constant) */
  name: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema definition for the AI model */
  definition: ToolDefinition;
  /** Execute the tool with parsed input arguments */
  execute: (
    input: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolExecutionResult>;
}

/**
 * Context passed to every tool execution. Provides the project root,
 * configuration, and any MCP client for web search.
 */
export interface ToolContext {
  /** Absolute path to the project root being analyzed */
  projectRoot: string;
  /** Optional MCP client for search_online and call_mcp tools */
  mcpCall?: (
    serverName: string,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<{ success: boolean; result: unknown; error?: string }>;
  /** Whether MCP is enabled */
  mcpEnabled: boolean;
  /** Maximum file size in bytes (overrides default) */
  maxFileSize?: number;
  /** Maximum lines per file (overrides default) */
  maxLines?: number;
}

// ── Security: Path Validation ───────────────────────────────────────────────

/**
 * Validate that a path is within the project root (prevent path traversal).
 *
 * @param targetPath  - The user/model-supplied path.
 * @param projectRoot - The project root boundary.
 * @returns The resolved absolute path if valid.
 * @throws Error if the path escapes the project root.
 */
function validatePath(targetPath: string, projectRoot: string): string {
  // Resolve relative to project root
  const resolved = resolve(projectRoot, targetPath);
  const normalizedRoot = resolve(projectRoot);

  if (!resolved.startsWith(normalizedRoot)) {
    throw new Error(
      `Path traversal blocked: "${targetPath}" resolves outside the project root.`,
    );
  }

  return resolved;
}

/**
 * Get a display-friendly relative path from the project root.
 */
function displayPath(absPath: string, projectRoot: string): string {
  const rel = relative(projectRoot, absPath);
  return rel || ".";
}

// ═════════════════════════════════════════════════════════════════════════════
// Tool 1: browse_dir
// ═════════════════════════════════════════════════════════════════════════════

const BROWSE_DIR_SCHEMA: ToolParametersSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Relative path to the directory to list (from the project root). " +
        'Use "." or "" for the project root itself.',
    },
  },
  required: ["path"],
};

async function executeBrowseDir(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const startMs = Date.now();
  const rawPath = String(input["path"] ?? ".");

  try {
    const absPath = validatePath(rawPath, context.projectRoot);

    const isDir = await isDirectory(absPath);
    if (!isDir) {
      const fileExists = await exists(absPath);
      if (!fileExists) {
        return {
          success: false,
          content: "",
          error: `Directory not found: ${rawPath}`,
          durationMs: Date.now() - startMs,
        };
      }
      return {
        success: false,
        content: "",
        error: `"${rawPath}" is a file, not a directory. Use browse_file to read it.`,
        durationMs: Date.now() - startMs,
      };
    }

    const entries = await listDirectory(absPath);
    const relDir = displayPath(absPath, context.projectRoot);

    // Format the listing
    const lines: string[] = [];
    lines.push(`Directory: ${relDir}/`);
    lines.push(`Entries: ${entries.length}`);
    lines.push("");

    // Separate directories and files
    const dirs = entries.filter((e) => e.isDirectory);
    const files = entries.filter((e) => !e.isDirectory);

    if (dirs.length > 0) {
      lines.push("Directories:");
      for (const d of dirs) {
        lines.push(`  ${FOLDER_ICON} ${d.name}/`);
      }
      lines.push("");
    }

    if (files.length > 0) {
      lines.push("Files:");
      for (const f of files) {
        const size =
          f.sizeBytes !== undefined ? ` (${formatBytes(f.sizeBytes)})` : "";
        const kindTag = f.kind ? ` [${f.kind}]` : "";
        lines.push(`  ${FILE_ICON} ${f.name}${size}${kindTag}`);
      }
    }

    if (entries.length === 0) {
      lines.push("(empty directory)");
    }

    const content = lines.join("\n");

    await appendAuditLog(
      `browse_dir: ${relDir}/ (${entries.length} entries)`,
      "tool",
    );

    return {
      success: true,
      content,
      durationMs: Date.now() - startMs,
      metadata: {
        path: relDir,
        dirCount: dirs.length,
        fileCount: files.length,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      content: "",
      error: message,
      durationMs: Date.now() - startMs,
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Tool 2: browse_file
// ═════════════════════════════════════════════════════════════════════════════

const BROWSE_FILE_SCHEMA: ToolParametersSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Relative path to the file to read (from the project root).",
    },
    start_line: {
      type: "string",
      description:
        "Optional starting line number (1-based). If provided with end_line, " +
        "only that range is returned.",
    },
    end_line: {
      type: "string",
      description:
        "Optional ending line number (1-based, inclusive). " +
        "If omitted but start_line is set, reads from start_line to end of file.",
    },
  },
  required: ["path"],
};

async function executeBrowseFile(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const startMs = Date.now();
  const rawPath = String(input["path"] ?? "");
  const startLine = input["start_line"]
    ? parseInt(String(input["start_line"]), 10)
    : undefined;
  const endLine = input["end_line"]
    ? parseInt(String(input["end_line"]), 10)
    : undefined;

  if (!rawPath) {
    return {
      success: false,
      content: "",
      error: "File path is required.",
      durationMs: Date.now() - startMs,
    };
  }

  try {
    const absPath = validatePath(rawPath, context.projectRoot);

    const fileOk = await isFile(absPath);
    if (!fileOk) {
      const dirOk = await isDirectory(absPath);
      if (dirOk) {
        return {
          success: false,
          content: "",
          error: `"${rawPath}" is a directory. Use browse_dir to list it.`,
          durationMs: Date.now() - startMs,
        };
      }
      return {
        success: false,
        content: "",
        error: `File not found: ${rawPath}`,
        durationMs: Date.now() - startMs,
      };
    }

    const relPath = displayPath(absPath, context.projectRoot);
    const maxSize = context.maxFileSize ?? MAX_FILE_SIZE_BYTES;
    const maxLines = context.maxLines ?? MAX_LINES_PER_FILE;

    // If line range is specified, use readFileLines
    if (startLine !== undefined && !isNaN(startLine)) {
      const effectiveEnd =
        endLine !== undefined && !isNaN(endLine) ? endLine : startLine + 500;
      const linesResult = await readFileLines(absPath, startLine, effectiveEnd);
      const lineRange = endLine
        ? `${startLine}-${endLine}`
        : `${startLine}-end`;

      if (!linesResult) {
        return {
          success: false,
          content: "",
          error: `Failed to read lines from file: ${rawPath}`,
          durationMs: Date.now() - startMs,
        };
      }

      const header = `File: ${relPath} (lines ${lineRange})`;
      const content = `${header}\n\n${linesResult.join("\n")}`;

      await appendAuditLog(
        `browse_file: ${relPath} lines ${lineRange}`,
        "tool",
      );

      return {
        success: true,
        content,
        durationMs: Date.now() - startMs,
        metadata: {
          path: relPath,
          lineRange,
          linesReturned: linesResult.length,
        },
      };
    }

    // Full file read
    const readResult = await safeReadFile(absPath, maxSize, maxLines);

    if (!readResult.ok) {
      return {
        success: false,
        content: "",
        error: readResult.error ?? `Failed to read file: ${rawPath}`,
        durationMs: Date.now() - startMs,
      };
    }

    const lines: string[] = [];
    lines.push(
      `File: ${relPath} (${readResult.lineCount} lines, ${formatBytes(readResult.sizeBytes ?? 0)})`,
    );
    if (readResult.truncated) {
      lines.push(
        `${WARNING_MARK} File was truncated (exceeded size or line limit). Showing partial content.`,
      );
    }
    lines.push("");
    lines.push(readResult.content);

    const content = lines.join("\n");

    await appendAuditLog(
      `browse_file: ${relPath} (${readResult.lineCount} lines)`,
      "tool",
    );

    return {
      success: true,
      content,
      durationMs: Date.now() - startMs,
      metadata: {
        path: relPath,
        lineCount: readResult.lineCount,
        sizeBytes: readResult.sizeBytes,
        truncated: readResult.truncated,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      content: "",
      error: message,
      durationMs: Date.now() - startMs,
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Tool 3: find_file_or_folder
// ═════════════════════════════════════════════════════════════════════════════

const FIND_FILE_OR_FOLDER_SCHEMA: ToolParametersSchema = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description:
        "Glob-like pattern to search for. Supports * and ** wildcards. " +
        'Examples: "*.ts", "src/**/*.test.ts", "Dockerfile", "package.json".',
    },
    path: {
      type: "string",
      description:
        'Optional subdirectory to search within (relative to project root). Default is "." (entire project).',
    },
    max_results: {
      type: "string",
      description: "Maximum number of results to return (default: 50).",
    },
  },
  required: ["pattern"],
};

async function executeFindFileOrFolder(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const startMs = Date.now();
  const pattern = String(input["pattern"] ?? "");
  const subPath = String(input["path"] ?? ".");
  const maxResults = input["max_results"]
    ? parseInt(String(input["max_results"]), 10)
    : 50;

  if (!pattern) {
    return {
      success: false,
      content: "",
      error: "Search pattern is required.",
      durationMs: Date.now() - startMs,
    };
  }

  try {
    const searchRoot = validatePath(subPath, context.projectRoot);

    const isDir = await isDirectory(searchRoot);
    if (!isDir) {
      return {
        success: false,
        content: "",
        error: `Search path is not a directory: ${subPath}`,
        durationMs: Date.now() - startMs,
      };
    }

    const matches = (await findFiles(searchRoot, pattern)).slice(
      0,
      Math.min(maxResults, 200),
    );

    const relRoot = displayPath(searchRoot, context.projectRoot);
    const relMatches = matches.map((m) =>
      displayPath(m.path, context.projectRoot),
    );

    const lines: string[] = [];
    lines.push(`Search: "${pattern}" in ${relRoot}/`);
    lines.push(
      `Results: ${relMatches.length}${relMatches.length >= maxResults ? " (limit reached)" : ""}`,
    );
    lines.push("");

    if (relMatches.length === 0) {
      lines.push("No files or folders matched the pattern.");
    } else {
      for (const match of relMatches) {
        lines.push(`  ${match}`);
      }
    }

    const content = lines.join("\n");

    await appendAuditLog(
      `find_file_or_folder: "${pattern}" in ${relRoot}/ (${relMatches.length} results)`,
      "tool",
    );

    return {
      success: true,
      content,
      durationMs: Date.now() - startMs,
      metadata: {
        pattern,
        searchPath: relRoot,
        resultCount: relMatches.length,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      content: "",
      error: message,
      durationMs: Date.now() - startMs,
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Tool 4: search_online
// ═════════════════════════════════════════════════════════════════════════════

const SEARCH_ONLINE_SCHEMA: ToolParametersSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "The search query to send to the web search MCP provider. " +
        "Be specific and security-focused for best results.",
    },
    max_results: {
      type: "string",
      description: "Maximum number of search results to return (default: 5).",
    },
  },
  required: ["query"],
};

async function executeSearchOnline(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const startMs = Date.now();
  const query = String(input["query"] ?? "");
  const maxResults = input["max_results"]
    ? parseInt(String(input["max_results"]), 10)
    : 5;

  if (!query) {
    return {
      success: false,
      content: "",
      error: "Search query is required.",
      durationMs: Date.now() - startMs,
    };
  }

  if (!context.mcpEnabled || !context.mcpCall) {
    return {
      success: false,
      content: "",
      error:
        "Web search is not enabled. Configure an MCP provider (Brave, Serper, Tavily) " +
        "in the settings (/conf) or during the setup wizard to enable online search.",
      durationMs: Date.now() - startMs,
    };
  }

  try {
    const result = await context.mcpCall("web-search", "search", {
      query,
      maxResults: Math.min(maxResults, 20),
    });

    if (!result.success) {
      return {
        success: false,
        content: "",
        error: result.error ?? "Web search failed.",
        durationMs: Date.now() - startMs,
      };
    }

    // Format the results
    const resultData = result.result;
    let content: string;

    if (typeof resultData === "string") {
      content = `Search results for: "${query}"\n\n${resultData}`;
    } else if (Array.isArray(resultData)) {
      const lines: string[] = [];
      lines.push(`Search results for: "${query}"`);
      lines.push(`Results: ${(resultData as unknown[]).length}`);
      lines.push("");

      for (let i = 0; i < (resultData as unknown[]).length; i++) {
        const item = (resultData as Record<string, unknown>[])[i];
        if (item && typeof item === "object") {
          const title = String(item["title"] ?? `Result ${i + 1}`);
          const url = String(item["url"] ?? item["link"] ?? "");
          const snippet = String(
            item["snippet"] ?? item["description"] ?? item["content"] ?? "",
          );
          lines.push(`${i + 1}. ${title}`);
          if (url) lines.push(`   URL: ${url}`);
          if (snippet) lines.push(`   ${snippet}`);
          lines.push("");
        }
      }

      content = lines.join("\n");
    } else if (resultData && typeof resultData === "object") {
      content = `Search results for: "${query}"\n\n${JSON.stringify(resultData, null, 2)}`;
    } else {
      content = `Search results for: "${query}"\n\n${String(resultData)}`;
    }

    await appendAuditLog(`search_online: "${query}"`, "tool");

    return {
      success: true,
      content,
      durationMs: Date.now() - startMs,
      metadata: { query, maxResults },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      content: "",
      error: `Web search error: ${message}`,
      durationMs: Date.now() - startMs,
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Tool 5: call_mcp
// ═════════════════════════════════════════════════════════════════════════════

const CALL_MCP_SCHEMA: ToolParametersSchema = {
  type: "object",
  properties: {
    server: {
      type: "string",
      description:
        "The MCP server name to call (e.g. 'context7', 'brave', 'serper', 'tavily').",
    },
    method: {
      type: "string",
      description: "The MCP method to invoke on the server.",
    },
    params: {
      type: "string",
      description:
        "JSON-encoded parameters to pass to the MCP method. " +
        'Example: \'{"query": "react hooks"}\'',
    },
  },
  required: ["server", "method"],
};

async function executeCallMCP(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const startMs = Date.now();
  const server = String(input["server"] ?? "");
  const method = String(input["method"] ?? "");
  const paramsRaw = input["params"];

  if (!server) {
    return {
      success: false,
      content: "",
      error: "MCP server name is required.",
      durationMs: Date.now() - startMs,
    };
  }

  if (!method) {
    return {
      success: false,
      content: "",
      error: "MCP method is required.",
      durationMs: Date.now() - startMs,
    };
  }

  if (!context.mcpEnabled || !context.mcpCall) {
    return {
      success: false,
      content: "",
      error:
        "MCP is not enabled. Configure MCP servers in the settings (/mcp) to enable this tool.",
      durationMs: Date.now() - startMs,
    };
  }

  // Parse params
  let params: Record<string, unknown> = {};
  if (paramsRaw) {
    if (typeof paramsRaw === "string") {
      try {
        params = JSON.parse(paramsRaw) as Record<string, unknown>;
      } catch {
        return {
          success: false,
          content: "",
          error: `Invalid JSON in params: ${String(paramsRaw)}`,
          durationMs: Date.now() - startMs,
        };
      }
    } else if (typeof paramsRaw === "object" && paramsRaw !== null) {
      params = paramsRaw as Record<string, unknown>;
    }
  }

  try {
    const result = await context.mcpCall(server, method, params);

    if (!result.success) {
      return {
        success: false,
        content: "",
        error: result.error ?? `MCP call to ${server}.${method} failed.`,
        durationMs: Date.now() - startMs,
      };
    }

    // Format the result
    let content: string;
    if (typeof result.result === "string") {
      content = result.result;
    } else {
      content = JSON.stringify(result.result, null, 2);
    }

    await appendAuditLog(
      `call_mcp: ${server}.${method}(${JSON.stringify(params).slice(0, 200)})`,
      "mcp",
    );

    return {
      success: true,
      content,
      durationMs: Date.now() - startMs,
      metadata: { server, method, params },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      content: "",
      error: `MCP call error: ${message}`,
      durationMs: Date.now() - startMs,
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Tool Registry
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The complete set of built-in tools available to the AI agent.
 *
 * Each entry contains the tool's JSON Schema definition (sent to the model)
 * and its execute function (called when the model invokes the tool).
 */
export const BUILTIN_TOOL_ENTRIES: BuiltinToolEntry[] = [
  {
    name: BUILTIN_TOOLS.BROWSE_DIR,
    description:
      "List the contents of a directory in the project. Shows files and " +
      "subdirectories with their sizes and types. Use this to explore the " +
      "project structure before reading specific files.",
    definition: {
      name: BUILTIN_TOOLS.BROWSE_DIR,
      description:
        "List the contents of a directory in the project. Shows files and " +
        "subdirectories with their sizes and types. Use this to explore the " +
        "project structure before reading specific files.",
      parameters: BROWSE_DIR_SCHEMA,
    },
    execute: executeBrowseDir,
  },
  {
    name: BUILTIN_TOOLS.BROWSE_FILE,
    description:
      "Read the contents of a file in the project. Optionally read only a " +
      "specific line range. Large files are automatically truncated. Use " +
      "this to examine source code, configuration files, and other text files.",
    definition: {
      name: BUILTIN_TOOLS.BROWSE_FILE,
      description:
        "Read the contents of a file in the project. Optionally read only a " +
        "specific line range. Large files are automatically truncated. Use " +
        "this to examine source code, configuration files, and other text files.",
      parameters: BROWSE_FILE_SCHEMA,
    },
    execute: executeBrowseFile,
  },
  {
    name: BUILTIN_TOOLS.FIND_FILE_OR_FOLDER,
    description:
      "Search for files or folders in the project by name pattern. Supports " +
      "glob-like wildcards (* and **). Use this to locate specific files " +
      "before reading them with browse_file.",
    definition: {
      name: BUILTIN_TOOLS.FIND_FILE_OR_FOLDER,
      description:
        "Search for files or folders in the project by name pattern. Supports " +
        "glob-like wildcards (* and **). Use this to locate specific files " +
        "before reading them with browse_file.",
      parameters: FIND_FILE_OR_FOLDER_SCHEMA,
    },
    execute: executeFindFileOrFolder,
  },
  {
    name: BUILTIN_TOOLS.SEARCH_ONLINE,
    description:
      "Search the web for security-related information, CVE details, " +
      "vulnerability advisories, and best practices. Requires MCP web search " +
      "to be configured. Use specific, security-focused queries for best results.",
    definition: {
      name: BUILTIN_TOOLS.SEARCH_ONLINE,
      description:
        "Search the web for security-related information, CVE details, " +
        "vulnerability advisories, and best practices. Requires MCP web search " +
        "to be configured.",
      parameters: SEARCH_ONLINE_SCHEMA,
    },
    execute: executeSearchOnline,
  },
  {
    name: BUILTIN_TOOLS.CALL_MCP,
    description:
      "Call an MCP (Model Context Protocol) server with a specific method " +
      "and parameters. Use this for advanced integrations like Context7 for " +
      "documentation lookups, or other configured MCP servers.",
    definition: {
      name: BUILTIN_TOOLS.CALL_MCP,
      description:
        "Call an MCP (Model Context Protocol) server with a specific method " +
        "and parameters. Use this for advanced integrations.",
      parameters: CALL_MCP_SCHEMA,
    },
    execute: executeCallMCP,
  },
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get all built-in tool definitions (for sending to the AI model).
 */
export function getBuiltinToolDefinitions(): ToolDefinition[] {
  return BUILTIN_TOOL_ENTRIES.map((entry) => entry.definition);
}

/**
 * Get a built-in tool entry by name.
 */
export function getBuiltinTool(name: string): BuiltinToolEntry | undefined {
  return BUILTIN_TOOL_ENTRIES.find((entry) => entry.name === name);
}

/**
 * Check if a tool name is a built-in tool.
 */
export function isBuiltinTool(name: string): boolean {
  return BUILTIN_TOOL_ENTRIES.some((entry) => entry.name === name);
}

/**
 * Execute a built-in tool by name.
 *
 * @param name    - The tool name.
 * @param input   - Parsed input arguments from the AI model.
 * @param context - Execution context (project root, MCP client, etc.).
 * @returns The tool's execution result.
 */
export async function executeBuiltinTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const tool = getBuiltinTool(name);

  if (!tool) {
    return {
      success: false,
      content: "",
      error: `Unknown built-in tool: "${name}". Available tools: ${BUILTIN_TOOL_ENTRIES.map((t) => t.name).join(", ")}`,
      durationMs: 0,
    };
  }

  try {
    return await tool.execute(input, context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      content: "",
      error: `Tool "${name}" threw an unexpected error: ${message}`,
      durationMs: 0,
    };
  }
}

/**
 * Get a summary list of all built-in tools (for display in /tools).
 */
export function getBuiltinToolSummary(): Array<{
  name: string;
  description: string;
}> {
  return BUILTIN_TOOL_ENTRIES.map((entry) => ({
    name: entry.name,
    description: entry.description,
  }));
}
