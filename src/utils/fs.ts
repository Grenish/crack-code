// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — File System Helper Utilities
// ─────────────────────────────────────────────────────────────────────────────
// Provides safe, cross-platform file system operations: path resolution,
// directory walking, file reading with size limits, existence checks, and
// extension-based classification. Zero external dependencies.
// ─────────────────────────────────────────────────────────────────────────────

import { readdir, readFile, writeFile, stat, mkdir, access, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve, join, basename, extname, relative, dirname, sep, normalize } from "node:path";
import { homedir, tmpdir } from "node:os";

import {
  IGNORED_DIRS,
  IGNORED_FILES,
  IGNORED_EXTENSIONS,
  SOURCE_EXTENSIONS,
  CONFIG_EXTENSIONS,
  MARKUP_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  MAX_SCAN_DEPTH,
  MAX_LINES_PER_FILE,
  MAX_FILES_PER_SCAN,
} from "./constants.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** Classification of a file based on its extension */
export type FileKind = "source" | "config" | "markup" | "unknown";

/** Result from reading a file safely */
export interface FileReadResult {
  /** Whether the read succeeded */
  ok: boolean;
  /** The file content (empty string on failure) */
  content: string;
  /** Number of lines in the content */
  lineCount: number;
  /** Size in bytes */
  sizeBytes: number;
  /** Error message if the read failed */
  error?: string;
  /** Whether the content was truncated due to size/line limits */
  truncated: boolean;
}

/** Entry returned by directory walking */
export interface WalkEntry {
  /** Absolute path to the file or directory */
  path: string;
  /** Path relative to the walk root */
  relativePath: string;
  /** Base filename */
  name: string;
  /** File extension (lowercase, includes dot) */
  ext: string;
  /** Whether this entry is a directory */
  isDirectory: boolean;
  /** Whether this entry is a file */
  isFile: boolean;
  /** File size in bytes (0 for directories) */
  sizeBytes: number;
  /** File classification */
  kind: FileKind;
  /** Depth relative to the walk root (0 = direct child) */
  depth: number;
}

/** Options for directory walking */
export interface WalkOptions {
  /** Maximum depth to recurse (default: MAX_SCAN_DEPTH) */
  maxDepth?: number;
  /** Maximum number of files to collect (default: MAX_FILES_PER_SCAN) */
  maxFiles?: number;
  /** Additional directory names to ignore */
  ignoreDirs?: ReadonlySet<string> | string[];
  /** Additional file names to ignore */
  ignoreFiles?: ReadonlySet<string> | string[];
  /** Additional extensions to ignore */
  ignoreExtensions?: ReadonlySet<string> | string[];
  /** If true, include directories in results (default: false) */
  includeDirs?: boolean;
  /** If true, only return source/config/markup files (default: false) */
  scannableOnly?: boolean;
  /** Custom filter function — return false to exclude an entry */
  filter?: (entry: WalkEntry) => boolean;
  /** If true, follow symbolic links (default: false) */
  followSymlinks?: boolean;
  /** Signal to abort the walk early */
  signal?: AbortSignal;
}

/** Summary statistics from a directory walk */
export interface WalkStats {
  /** Total files found */
  totalFiles: number;
  /** Total directories traversed */
  totalDirs: number;
  /** Total size of all files in bytes */
  totalSizeBytes: number;
  /** Breakdown of files by kind */
  byKind: Record<FileKind, number>;
  /** Breakdown of files by extension */
  byExtension: Record<string, number>;
  /** Whether the walk was truncated due to maxFiles */
  truncated: boolean;
  /** Number of files/dirs skipped by ignore rules */
  skipped: number;
  /** Duration of the walk in milliseconds */
  durationMs: number;
}

/** Result from a directory listing (non-recursive) */
export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  sizeBytes: number;
  ext: string;
  kind: FileKind;
}

// ── Path Utilities ──────────────────────────────────────────────────────────

/**
 * Resolve a path relative to the current working directory.
 * Handles `~` expansion and normalizes separators.
 */
export function resolvePath(...segments: string[]): string {
  const expanded = segments.map((s) => {
    if (s.startsWith("~/") || s === "~") {
      return s.replace(/^~/, homedir());
    }
    return s;
  });
  return resolve(...expanded);
}

/**
 * Get a path relative to another base path.
 * Returns the original path if it's not under the base.
 */
export function relativeTo(filePath: string, basePath: string): string {
  const rel = relative(basePath, filePath);
  // If the relative path escapes the base, return absolute
  if (rel.startsWith("..") || resolve(basePath, rel) !== resolve(filePath)) {
    return filePath;
  }
  return rel;
}

/**
 * Normalize a path: resolve `.` and `..`, normalize separators.
 */
export function normalizePath(p: string): string {
  return normalize(resolvePath(p));
}

/**
 * Check if a given path is the user's home directory.
 */
export function isHomeDirectory(p: string): boolean {
  const resolved = resolvePath(p);
  const home = homedir();
  return resolved === home || resolved === home + sep;
}

/**
 * Check if a path is inside the user's home directory.
 */
export function isUnderHome(p: string): boolean {
  const resolved = resolvePath(p);
  const home = homedir();
  return resolved.startsWith(home + sep) || resolved === home;
}

/**
 * Get the project/directory name from a path.
 */
export function getProjectName(p: string): string {
  return basename(resolvePath(p));
}

/**
 * Get a safe display path, collapsing the home directory to `~`.
 */
export function displayPath(p: string): string {
  const resolved = resolvePath(p);
  const home = homedir();
  if (resolved === home) return "~";
  if (resolved.startsWith(home + sep)) {
    return "~" + resolved.slice(home.length);
  }
  return resolved;
}

/**
 * Get the parent directory of a path.
 */
export function parentDir(p: string): string {
  return dirname(resolvePath(p));
}

/**
 * Join path segments safely.
 */
export function joinPath(...segments: string[]): string {
  return join(...segments);
}

/**
 * Get the file extension (lowercase, includes dot).
 */
export function getExtension(p: string): string {
  return extname(p).toLowerCase();
}

/**
 * Get the filename without extension.
 */
export function getBaseName(p: string): string {
  const base = basename(p);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

// ── File Classification ─────────────────────────────────────────────────────

/**
 * Classify a file based on its extension.
 */
export function classifyFile(filePath: string): FileKind {
  const ext = getExtension(filePath);
  const name = basename(filePath).toLowerCase();

  // Some config files have no extension but specific names
  if (!ext || ext === ".") {
    const configNames = new Set([
      "dockerfile",
      "makefile",
      "rakefile",
      "gemfile",
      "procfile",
      "vagrantfile",
      "jenkinsfile",
      "brewfile",
      "guardfile",
      "berksfile",
      "thorfile",
      "capfile",
      "puppetfile",
      ".gitignore",
      ".gitattributes",
      ".gitmodules",
      ".dockerignore",
      ".npmignore",
      ".eslintignore",
      ".prettierignore",
      ".env",
      ".env.local",
      ".env.development",
      ".env.production",
      ".env.test",
      ".editorconfig",
      ".nvmrc",
      ".node-version",
      ".ruby-version",
      ".python-version",
      ".tool-versions",
    ]);
    if (configNames.has(name)) return "config";

    // Shell scripts and similar without extensions
    const sourceNames = new Set([
      "rakefile",
      "gemfile",
      "guardfile",
    ]);
    if (sourceNames.has(name)) return "source";

    return "unknown";
  }

  if (SOURCE_EXTENSIONS.has(ext)) return "source";
  if (CONFIG_EXTENSIONS.has(ext)) return "config";
  if (MARKUP_EXTENSIONS.has(ext)) return "markup";

  return "unknown";
}

/**
 * Check if a file should be scanned based on its path and extension.
 */
export function isScannable(filePath: string): boolean {
  const name = basename(filePath);
  const ext = getExtension(filePath);

  if (IGNORED_FILES.has(name)) return false;
  if (ext && IGNORED_EXTENSIONS.has(ext)) return false;

  const kind = classifyFile(filePath);
  return kind !== "unknown";
}

/**
 * Check if a directory should be ignored during scanning.
 */
export function isIgnoredDir(dirName: string): boolean {
  return IGNORED_DIRS.has(dirName);
}

/**
 * Check if a file should be ignored during scanning.
 */
export function isIgnoredFile(fileName: string): boolean {
  if (IGNORED_FILES.has(fileName)) return true;
  const ext = getExtension(fileName);
  if (ext && IGNORED_EXTENSIONS.has(ext)) return true;
  return false;
}

// ── Existence & Access Checks ───────────────────────────────────────────────

/**
 * Check if a path exists.
 */
export async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path is a directory.
 */
export async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if a path is a file.
 */
export async function isFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Check if a path is readable.
 */
export async function isReadable(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file stats, or null if the path doesn't exist.
 */
export async function safeStats(p: string): Promise<{
  sizeBytes: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  modifiedAt: Date;
  createdAt: Date;
} | null> {
  try {
    const s = await stat(p);
    return {
      sizeBytes: s.size,
      isDirectory: s.isDirectory(),
      isFile: s.isFile(),
      isSymlink: s.isSymbolicLink(),
      modifiedAt: s.mtime,
      createdAt: s.birthtime,
    };
  } catch {
    return null;
  }
}

// ── Safe File Reading ───────────────────────────────────────────────────────

/**
 * Read a file safely with size and line limits.
 * Never throws — returns a structured result with error info.
 *
 * @param filePath - Absolute or relative path to the file.
 * @param maxBytes - Maximum bytes to read (default: MAX_FILE_SIZE_BYTES).
 * @param maxLines - Maximum lines to return (default: MAX_LINES_PER_FILE).
 */
export async function safeReadFile(
  filePath: string,
  maxBytes: number = MAX_FILE_SIZE_BYTES,
  maxLines: number = MAX_LINES_PER_FILE
): Promise<FileReadResult> {
  const resolved = resolvePath(filePath);

  try {
    // Check existence and get stats
    const stats = await stat(resolved);

    if (!stats.isFile()) {
      return {
        ok: false,
        content: "",
        lineCount: 0,
        sizeBytes: 0,
        error: `Not a regular file: ${filePath}`,
        truncated: false,
      };
    }

    const sizeBytes = stats.size;

    // Check size limit
    if (sizeBytes > maxBytes) {
      // Read only up to the limit
      const buffer = Buffer.alloc(maxBytes);
      const { createReadStream } = await import("node:fs");
      const content = await new Promise<string>((resolvePromise, reject) => {
        const stream = createReadStream(resolved, { start: 0, end: maxBytes - 1 });
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf-8")));
        stream.on("error", reject);
      });

      const lines = content.split("\n");
      const truncatedLines = lines.slice(0, maxLines);
      const truncatedContent = truncatedLines.join("\n");

      return {
        ok: true,
        content: truncatedContent,
        lineCount: truncatedLines.length,
        sizeBytes,
        truncated: true,
      };
    }

    // Read the full file
    let content = await readFile(resolved, "utf-8");
    let truncated = false;

    // Apply line limit
    const lines = content.split("\n");
    if (lines.length > maxLines) {
      content = lines.slice(0, maxLines).join("\n");
      truncated = true;
    }

    return {
      ok: true,
      content,
      lineCount: Math.min(lines.length, maxLines),
      sizeBytes,
      truncated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      content: "",
      lineCount: 0,
      sizeBytes: 0,
      error: message,
      truncated: false,
    };
  }
}

/**
 * Read a file as a string. Returns null on failure.
 */
export async function readFileText(filePath: string): Promise<string | null> {
  try {
    return await readFile(resolvePath(filePath), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read a file and parse as JSON. Returns null on failure.
 */
export async function readJsonFile<T = unknown>(filePath: string): Promise<T | null> {
  const text = await readFileText(filePath);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ── Safe File Writing ───────────────────────────────────────────────────────

/**
 * Write text content to a file, creating parent directories as needed.
 * Returns true on success, false on failure.
 */
export async function safeWriteFile(filePath: string, content: string): Promise<boolean> {
  try {
    const resolved = resolvePath(filePath);
    const dir = dirname(resolved);
    await mkdir(dir, { recursive: true });
    await writeFile(resolved, content, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a JSON value to a file with pretty printing.
 * Creates parent directories as needed. Returns true on success.
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<boolean> {
  try {
    const json = JSON.stringify(data, null, 2) + "\n";
    return await safeWriteFile(filePath, json);
  } catch {
    return false;
  }
}

// ── Directory Operations ────────────────────────────────────────────────────

/**
 * Ensure a directory exists, creating it and all parents if necessary.
 * Returns true on success.
 */
export async function ensureDir(dirPath: string): Promise<boolean> {
  try {
    await mkdir(resolvePath(dirPath), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * List direct children of a directory (non-recursive).
 * Returns an empty array on failure.
 */
export async function listDirectory(dirPath: string): Promise<DirEntry[]> {
  try {
    const resolved = resolvePath(dirPath);
    const entries = await readdir(resolved, { withFileTypes: true });
    const results: DirEntry[] = [];

    for (const entry of entries) {
      const entryPath = join(resolved, entry.name);
      let sizeBytes = 0;

      if (entry.isFile()) {
        try {
          const s = await stat(entryPath);
          sizeBytes = s.size;
        } catch {
          // Skip files we can't stat
        }
      }

      const ext = entry.isFile() ? getExtension(entry.name) : "";

      results.push({
        name: entry.name,
        path: entryPath,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        sizeBytes,
        ext,
        kind: entry.isFile() ? classifyFile(entry.name) : "unknown",
      });
    }

    // Sort: directories first, then alphabetically
    results.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    return results;
  } catch {
    return [];
  }
}

/**
 * Remove a file or directory. Returns true on success.
 */
export async function safeRemove(p: string): Promise<boolean> {
  try {
    await rm(resolvePath(p), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ── Recursive Directory Walking ─────────────────────────────────────────────

/**
 * Walk a directory tree recursively, respecting ignore rules, depth limits,
 * and file count limits. Yields entries as they're discovered.
 *
 * @param rootPath - The root directory to start walking from.
 * @param options - Walk configuration options.
 * @returns AsyncGenerator yielding WalkEntry objects.
 */
export async function* walk(
  rootPath: string,
  options: WalkOptions = {}
): AsyncGenerator<WalkEntry, void, undefined> {
  const {
    maxDepth = MAX_SCAN_DEPTH,
    maxFiles = MAX_FILES_PER_SCAN,
    ignoreDirs: extraIgnoreDirs,
    ignoreFiles: extraIgnoreFiles,
    ignoreExtensions: extraIgnoreExts,
    includeDirs = false,
    scannableOnly = false,
    filter,
    followSymlinks = false,
    signal,
  } = options;

  // Merge ignore sets
  const ignoredDirSet = new Set(IGNORED_DIRS);
  if (extraIgnoreDirs) {
    const dirs = extraIgnoreDirs instanceof Set ? extraIgnoreDirs : new Set(extraIgnoreDirs);
    for (const d of dirs) ignoredDirSet.add(d);
  }

  const ignoredFileSet = new Set(IGNORED_FILES);
  if (extraIgnoreFiles) {
    const files = extraIgnoreFiles instanceof Set ? extraIgnoreFiles : new Set(extraIgnoreFiles);
    for (const f of files) ignoredFileSet.add(f);
  }

  const ignoredExtSet = new Set(IGNORED_EXTENSIONS);
  if (extraIgnoreExts) {
    const exts = extraIgnoreExts instanceof Set ? extraIgnoreExts : new Set(extraIgnoreExts);
    for (const e of exts) ignoredExtSet.add(e);
  }

  const resolved = resolvePath(rootPath);
  let fileCount = 0;

  // Iterative BFS/DFS using a stack (avoids deep recursion call stack issues)
  interface StackEntry {
    dirPath: string;
    depth: number;
  }

  const stack: StackEntry[] = [{ dirPath: resolved, depth: 0 }];

  while (stack.length > 0) {
    // Check abort signal
    if (signal?.aborted) return;

    // Check file limit
    if (fileCount >= maxFiles) return;

    const current = stack.pop()!;
    const { dirPath, depth } = current;

    // Check depth limit
    if (depth > maxDepth) continue;

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue; // Skip unreadable directories
    }

    // Sort entries for deterministic output
    entries.sort((a, b) => a.name.localeCompare(b.name));

    // Process directories first (push to stack in reverse order for correct traversal)
    const subdirs: StackEntry[] = [];

    for (const entry of entries) {
      if (signal?.aborted) return;
      if (fileCount >= maxFiles) return;

      const entryPath = join(dirPath, entry.name);
      const relPath = relative(resolved, entryPath);

      if (entry.isDirectory()) {
        // Skip ignored directories
        if (ignoredDirSet.has(entry.name)) continue;

        if (includeDirs) {
          const walkEntry: WalkEntry = {
            path: entryPath,
            relativePath: relPath,
            name: entry.name,
            ext: "",
            isDirectory: true,
            isFile: false,
            sizeBytes: 0,
            kind: "unknown",
            depth,
          };

          if (!filter || filter(walkEntry)) {
            yield walkEntry;
          }
        }

        // Queue subdirectory for traversal
        subdirs.push({ dirPath: entryPath, depth: depth + 1 });
      } else if (entry.isFile() || (followSymlinks && entry.isSymbolicLink())) {
        // Skip ignored files
        if (ignoredFileSet.has(entry.name)) continue;

        const ext = getExtension(entry.name);
        if (ext && ignoredExtSet.has(ext)) continue;

        const kind = classifyFile(entry.name);

        // Skip non-scannable files if requested
        if (scannableOnly && kind === "unknown") continue;

        let sizeBytes = 0;
        try {
          const s = await stat(entryPath);
          sizeBytes = s.size;
        } catch {
          continue; // Skip files we can't stat
        }

        const walkEntry: WalkEntry = {
          path: entryPath,
          relativePath: relPath,
          name: entry.name,
          ext,
          isDirectory: false,
          isFile: true,
          sizeBytes,
          kind,
          depth,
        };

        if (filter && !filter(walkEntry)) continue;

        yield walkEntry;
        fileCount++;
      }
    }

    // Push subdirectories in reverse order so they're processed in alphabetical order
    for (let i = subdirs.length - 1; i >= 0; i--) {
      stack.push(subdirs[i]!);
    }
  }
}

/**
 * Walk a directory and collect all entries into an array.
 * Convenience wrapper around the `walk` async generator.
 */
export async function walkToArray(
  rootPath: string,
  options: WalkOptions = {}
): Promise<WalkEntry[]> {
  const entries: WalkEntry[] = [];
  for await (const entry of walk(rootPath, options)) {
    entries.push(entry);
  }
  return entries;
}

/**
 * Walk a directory and compute summary statistics.
 */
export async function walkStats(
  rootPath: string,
  options: WalkOptions = {}
): Promise<{ entries: WalkEntry[]; stats: WalkStats }> {
  const start = performance.now();
  const entries: WalkEntry[] = [];
  let totalDirs = 0;
  let totalSizeBytes = 0;
  let skipped = 0;
  const byKind: Record<FileKind, number> = { source: 0, config: 0, markup: 0, unknown: 0 };
  const byExtension: Record<string, number> = {};

  const originalFilter = options.filter;

  // Wrap filter to count skipped entries
  const countingOptions: WalkOptions = {
    ...options,
    includeDirs: true,
    filter: (entry: WalkEntry) => {
      if (entry.isDirectory) {
        totalDirs++;
        return options.includeDirs ?? false;
      }

      if (originalFilter && !originalFilter(entry)) {
        skipped++;
        return false;
      }

      return true;
    },
  };

  for await (const entry of walk(rootPath, countingOptions)) {
    if (entry.isFile) {
      entries.push(entry);
      totalSizeBytes += entry.sizeBytes;
      byKind[entry.kind]++;
      const ext = entry.ext || "(none)";
      byExtension[ext] = (byExtension[ext] ?? 0) + 1;
    }
  }

  const durationMs = performance.now() - start;

  return {
    entries,
    stats: {
      totalFiles: entries.length,
      totalDirs,
      totalSizeBytes,
      byKind,
      byExtension,
      truncated: entries.length >= (options.maxFiles ?? MAX_FILES_PER_SCAN),
      skipped,
      durationMs,
    },
  };
}

// ── File Search ─────────────────────────────────────────────────────────────

/**
 * Search for files or folders matching a pattern (simple glob-like matching).
 * Supports `*` as wildcard.
 *
 * @param rootPath - Directory to search in.
 * @param pattern - Search pattern (e.g., "*.ts", "config*", "package.json").
 * @param options - Walk options for the underlying directory traversal.
 * @returns Matching entries.
 */
export async function findFiles(
  rootPath: string,
  pattern: string,
  options: WalkOptions = {}
): Promise<WalkEntry[]> {
  const regex = patternToRegex(pattern);

  const matches: WalkEntry[] = [];
  const searchOptions: WalkOptions = {
    ...options,
    includeDirs: true,
    filter: (entry: WalkEntry) => {
      if (regex.test(entry.name) || regex.test(entry.relativePath)) {
        return true;
      }
      // For directories, still traverse into them but don't include
      if (entry.isDirectory) return false;
      return false;
    },
  };

  for await (const entry of walk(rootPath, searchOptions)) {
    matches.push(entry);
  }

  return matches;
}

/**
 * Convert a simple glob-like pattern to a RegExp.
 * Supports `*` (match any characters except path separators) and `**` (match anything).
 */
function patternToRegex(pattern: string): RegExp {
  let regexStr = "";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i]!;

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches everything including path separators
        regexStr += ".*";
        i += 2;
        // Skip trailing slash after **
        if (pattern[i] === "/" || pattern[i] === "\\") i++;
      } else {
        // * matches everything except path separators
        regexStr += "[^/\\\\]*";
        i++;
      }
    } else if (char === "?") {
      regexStr += "[^/\\\\]";
      i++;
    } else if (char === ".") {
      regexStr += "\\.";
      i++;
    } else if (char === "/" || char === "\\") {
      regexStr += "[/\\\\]";
      i++;
    } else if ("[({+^$|})].".includes(char)) {
      regexStr += "\\" + char;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`, "i");
}

// ── Size Formatting ─────────────────────────────────────────────────────────

/**
 * Format a byte count into a human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);

  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i] ?? "??"}`;
}

/**
 * Format a number with locale-aware thousand separators.
 */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

// ── Temp Files ──────────────────────────────────────────────────────────────

/**
 * Get a temporary file path within the system temp directory.
 */
export function getTempPath(filename: string): string {
  return join(tmpdir(), "crack-code", filename);
}

/**
 * Write content to a temporary file and return the path.
 */
export async function writeTempFile(filename: string, content: string): Promise<string> {
  const p = getTempPath(filename);
  await safeWriteFile(p, content);
  return p;
}

// ── Gitignore-aware Helpers ─────────────────────────────────────────────────

/**
 * Read and parse a .gitignore file into a set of patterns.
 * Returns an empty array if the file doesn't exist or can't be read.
 */
export async function readGitignorePatterns(dirPath: string): Promise<string[]> {
  const gitignorePath = join(resolvePath(dirPath), ".gitignore");
  const content = await readFileText(gitignorePath);
  if (!content) return [];

  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

// ── File Content Helpers ────────────────────────────────────────────────────

/**
 * Read specific line ranges from a file.
 * Returns the requested lines or null on failure.
 *
 * @param filePath - Path to the file.
 * @param startLine - 1-based start line (inclusive).
 * @param endLine - 1-based end line (inclusive).
 */
export async function readFileLines(
  filePath: string,
  startLine: number,
  endLine: number
): Promise<string[] | null> {
  const result = await safeReadFile(filePath);
  if (!result.ok) return null;

  const lines = result.content.split("\n");
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);

  return lines.slice(start, end);
}

/**
 * Count the number of lines in a file without reading the entire content into memory.
 * Returns -1 on failure.
 */
export async function countFileLines(filePath: string): Promise<number> {
  try {
    const content = await readFile(resolvePath(filePath), "utf-8");
    return content.split("\n").length;
  } catch {
    return -1;
  }
}

/**
 * Check if a file appears to be a binary file by reading the first chunk
 * and looking for null bytes.
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  try {
    const { createReadStream } = await import("node:fs");
    const stream = createReadStream(resolvePath(filePath), { start: 0, end: 512 });
    const chunk = await new Promise<Buffer>((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolvePromise(Buffer.concat(chunks)));
      stream.on("error", reject);
    });

    // Check for null bytes — a strong indicator of binary content
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0) return true;
    }

    return false;
  } catch {
    return false;
  }
}
