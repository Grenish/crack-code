// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Project Scanner
// ─────────────────────────────────────────────────────────────────────────────
// Recursively walks a project directory, respecting ignore rules, file-size
// limits, and depth constraints. Builds a structured context map of every
// scannable file — content, metadata, classification, and line-level data —
// ready for downstream analyzers and the AI agent.
//
// The scanner is purely read-only. It NEVER modifies any source file.
//
// Zero external dependencies — uses only Node built-ins and project utils.
// ─────────────────────────────────────────────────────────────────────────────

import { resolve, relative, basename, extname, join } from "node:path";

import {
  walk,
  walkToArray,
  safeReadFile,
  safeStats,
  exists,
  isDirectory,
  listDirectory,
  classifyFile,
  isScannable,
  readGitignorePatterns,
  formatBytes,
  type WalkEntry,
  type WalkOptions,
  type FileReadResult,
  type FileKind,
} from "../utils/fs.js";

import {
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_SCAN,
  MAX_SCAN_DEPTH,
  MAX_LINES_PER_FILE,
  IGNORED_DIRS,
  IGNORED_FILES,
  IGNORED_EXTENSIONS,
  SOURCE_EXTENSIONS,
  CONFIG_EXTENSIONS,
  MARKUP_EXTENSIONS,
} from "../utils/constants.js";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Classification of a file for the purpose of security scanning.
 */
export type ScanFileKind =
  | "source" // Application source code
  | "config" // Configuration / data files
  | "markup" // HTML, templates, stylesheets, SQL, etc.
  | "manifest" // Package manifests (package.json, Cargo.toml, etc.)
  | "lockfile" // Lock files (package-lock.json, bun.lock, etc.)
  | "dockerfile" // Dockerfiles
  | "cicd" // CI/CD pipeline files
  | "infra" // Infrastructure-as-code (Terraform, etc.)
  | "env" // Environment files (.env, .env.local, etc.)
  | "unknown"; // Unclassified but still scanned

/**
 * A single scanned file with its content and metadata.
 */
export interface ScannedFile {
  /** Absolute path */
  path: string;
  /** Relative path from the project root */
  relativePath: string;
  /** File name (basename) */
  name: string;
  /** File extension (e.g. ".ts") */
  ext: string;
  /** File classification */
  kind: ScanFileKind;
  /** Generic classification from utils/fs */
  fsKind: FileKind;
  /** File content (may be truncated) */
  content: string;
  /** Number of lines */
  lineCount: number;
  /** File size in bytes */
  sizeBytes: number;
  /** Whether the content was truncated due to size/line limits */
  truncated: boolean;
  /** Whether the file was successfully read */
  readOk: boolean;
  /** Error message if read failed */
  readError?: string;
  /** Line-level data for targeted analysis */
  lines: string[];
}

/**
 * A scanned dependency manifest with parsed data.
 */
export interface ScannedManifest {
  /** The scanned file info */
  file: ScannedFile;
  /** Manifest type */
  type: ManifestType;
  /** Parsed dependencies (name → version) */
  dependencies: Record<string, string>;
  /** Parsed dev dependencies (name → version) */
  devDependencies: Record<string, string>;
  /** Raw parsed JSON/TOML (if applicable) */
  parsed: Record<string, unknown> | null;
}

/**
 * Recognized package manifest types.
 */
export type ManifestType =
  | "npm" // package.json
  | "pip" // requirements.txt / Pipfile
  | "cargo" // Cargo.toml
  | "go" // go.mod
  | "maven" // pom.xml
  | "gradle" // build.gradle
  | "composer" // composer.json
  | "gemfile" // Gemfile
  | "pubspec" // pubspec.yaml
  | "nuget" // *.csproj
  | "unknown";

/**
 * Summary statistics for a completed scan.
 */
export interface ScanStats {
  /** Total files discovered (before filtering) */
  totalDiscovered: number;
  /** Files actually scanned (read successfully) */
  scannedFiles: number;
  /** Files skipped (binary, too large, ignored, etc.) */
  skippedFiles: number;
  /** Files that failed to read */
  failedFiles: number;
  /** Files truncated during read */
  truncatedFiles: number;
  /** Total bytes across all scanned files */
  totalBytes: number;
  /** Total lines across all scanned files */
  totalLines: number;
  /** Breakdown by file kind */
  byKind: Record<ScanFileKind, number>;
  /** Breakdown by extension */
  byExtension: Record<string, number>;
  /** Number of detected manifests */
  manifestCount: number;
  /** Number of .env files found */
  envFileCount: number;
  /** Scan duration in milliseconds */
  durationMs: number;
}

/**
 * Complete result of a project scan.
 */
export interface ScanResult {
  /** The target project root that was scanned */
  projectRoot: string;
  /** Project name (derived from directory name or manifest) */
  projectName: string;
  /** All scanned files */
  files: ScannedFile[];
  /** Detected package manifests */
  manifests: ScannedManifest[];
  /** Detected .env files (potential secrets exposure) */
  envFiles: ScannedFile[];
  /** Detected Dockerfiles */
  dockerfiles: ScannedFile[];
  /** Detected CI/CD config files */
  cicdFiles: ScannedFile[];
  /** Detected infra-as-code files */
  infraFiles: ScannedFile[];
  /** Scan statistics */
  stats: ScanStats;
  /** ISO timestamp when the scan started */
  startedAt: string;
  /** ISO timestamp when the scan completed */
  completedAt: string;
  /** Warnings emitted during scanning */
  warnings: string[];
  /** Whether the scan completed fully (vs. hitting limits) */
  complete: boolean;
  /** Gitignore patterns found (informational) */
  gitignorePatterns: string[];
}

/**
 * Options to configure the scanner behavior.
 */
export interface ScanOptions {
  /** Maximum file size in bytes (default: MAX_FILE_SIZE_BYTES) */
  maxFileSize?: number;
  /** Maximum number of files to scan (default: MAX_FILES_PER_SCAN) */
  maxFiles?: number;
  /** Maximum directory depth (default: MAX_SCAN_DEPTH) */
  maxDepth?: number;
  /** Maximum lines per file (default: MAX_LINES_PER_FILE) */
  maxLines?: number;
  /** Additional directories to ignore */
  extraIgnoreDirs?: string[];
  /** Additional file patterns to ignore */
  extraIgnoreFiles?: string[];
  /** Only scan files matching these extensions (e.g. [".ts", ".js"]) */
  onlyExtensions?: string[];
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Progress callback: called after each file is scanned */
  onProgress?: (scanned: number, total: number, currentFile: string) => void;
  /** Whether to include file content in results (default: true) */
  includeContent?: boolean;
  /** Whether to parse manifests (default: true) */
  parseManifests?: boolean;
}

// ── Scanner ─────────────────────────────────────────────────────────────────

/**
 * Scan a project directory and build a structured context of all scannable
 * files, their content, metadata, and classification.
 *
 * @param targetPath - The directory to scan (absolute or relative).
 * @param options    - Configuration options.
 * @returns A complete ScanResult with all file data and statistics.
 */
export async function scanProject(
  targetPath: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const projectRoot = resolve(targetPath);
  const warnings: string[] = [];

  // Validate target exists and is a directory
  const targetExists = await exists(projectRoot);
  if (!targetExists) {
    return createEmptyScanResult(projectRoot, startedAt, [
      `Target path does not exist: ${projectRoot}`,
    ]);
  }

  const isDir = await isDirectory(projectRoot);
  if (!isDir) {
    return createEmptyScanResult(projectRoot, startedAt, [
      `Target path is not a directory: ${projectRoot}`,
    ]);
  }

  // Apply defaults
  const maxFileSize = options.maxFileSize ?? MAX_FILE_SIZE_BYTES;
  const maxFiles = options.maxFiles ?? MAX_FILES_PER_SCAN;
  const maxDepth = options.maxDepth ?? MAX_SCAN_DEPTH;
  const maxLines = options.maxLines ?? MAX_LINES_PER_FILE;
  const includeContent = options.includeContent ?? true;
  const parseManifests = options.parseManifests ?? true;

  // Read .gitignore patterns
  let gitignorePatterns: string[] = [];
  try {
    gitignorePatterns = await readGitignorePatterns(projectRoot);
  } catch {
    // No .gitignore — that's fine
  }

  // Determine project name
  const projectName = await detectProjectName(projectRoot);

  // ── Walk and collect file entries ─────────────────────────────────

  const walkOptions: WalkOptions = {
    maxDepth,
    maxFiles: maxFiles * 2, // Walk more than we need so we can filter
    includeDirs: false,
    ignoreDirs: options.extraIgnoreDirs,
    ignoreFiles: options.extraIgnoreFiles,
    ignoreExtensions: options.onlyExtensions ? undefined : undefined,
    signal: options.signal,
    filter: (entry: WalkEntry) => {
      // Extension filter
      if (options.onlyExtensions && options.onlyExtensions.length > 0) {
        if (!options.onlyExtensions.includes(entry.ext)) {
          return false;
        }
      }
      return true;
    },
  };

  let allEntries: WalkEntry[];
  try {
    allEntries = await walkToArray(projectRoot, walkOptions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return createEmptyScanResult(projectRoot, startedAt, [
      `Failed to walk directory: ${message}`,
    ]);
  }

  // Limit to maxFiles
  let complete = true;
  if (allEntries.length > maxFiles) {
    warnings.push(
      `File limit reached: found ${allEntries.length} files, scanning first ${maxFiles}.`,
    );
    allEntries = allEntries.slice(0, maxFiles);
    complete = false;
  }

  // ── Scan each file ────────────────────────────────────────────────

  const scannedFiles: ScannedFile[] = [];
  const manifests: ScannedManifest[] = [];
  const envFiles: ScannedFile[] = [];
  const dockerfiles: ScannedFile[] = [];
  const cicdFiles: ScannedFile[] = [];
  const infraFiles: ScannedFile[] = [];

  let totalDiscovered = allEntries.length;
  let scannedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let truncatedCount = 0;
  let totalBytes = 0;
  let totalLineCount = 0;

  const byKind: Record<ScanFileKind, number> = {
    source: 0,
    config: 0,
    markup: 0,
    manifest: 0,
    lockfile: 0,
    dockerfile: 0,
    cicd: 0,
    infra: 0,
    env: 0,
    unknown: 0,
  };
  const byExtension: Record<string, number> = {};

  for (let i = 0; i < allEntries.length; i++) {
    // Check for cancellation
    if (options.signal?.aborted) {
      warnings.push("Scan cancelled by signal.");
      complete = false;
      break;
    }

    const entry = allEntries[i]!;
    const relPath = entry.relativePath;
    const ext = entry.ext;
    const name = entry.name;

    // Skip files that are too large (based on walk entry size)
    if (entry.sizeBytes > maxFileSize) {
      skippedCount++;
      warnings.push(
        `Skipped (too large): ${relPath} (${formatBytes(entry.sizeBytes)})`,
      );
      continue;
    }

    // Classify the file
    const fsKind = classifyFile(entry.path);
    const scanKind = classifyScanFile(name, ext, relPath);

    // Read the file
    let readResult: FileReadResult;
    try {
      readResult = await safeReadFile(entry.path, maxFileSize, maxLines);
    } catch (err) {
      failedCount++;
      const errMsg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to read: ${relPath} — ${errMsg}`);
      continue;
    }

    if (!readResult.ok) {
      failedCount++;
      if (readResult.error) {
        warnings.push(`Failed to read: ${relPath} — ${readResult.error}`);
      }
      continue;
    }

    const content = includeContent ? readResult.content : "";
    const lines = includeContent ? readResult.content.split("\n") : [];
    const lineCount = readResult.lineCount;
    const sizeBytes = readResult.sizeBytes ?? entry.sizeBytes;

    if (readResult.truncated) {
      truncatedCount++;
    }

    const scannedFile: ScannedFile = {
      path: entry.path,
      relativePath: relPath,
      name,
      ext,
      kind: scanKind,
      fsKind,
      content,
      lineCount,
      sizeBytes,
      truncated: readResult.truncated,
      readOk: true,
      lines,
    };

    scannedFiles.push(scannedFile);
    scannedCount++;
    totalBytes += sizeBytes;
    totalLineCount += lineCount;

    // Track stats
    byKind[scanKind] = (byKind[scanKind] ?? 0) + 1;
    const extKey = ext || "(no ext)";
    byExtension[extKey] = (byExtension[extKey] ?? 0) + 1;

    // Categorize special files
    if (scanKind === "env") {
      envFiles.push(scannedFile);
    }
    if (scanKind === "dockerfile") {
      dockerfiles.push(scannedFile);
    }
    if (scanKind === "cicd") {
      cicdFiles.push(scannedFile);
    }
    if (scanKind === "infra") {
      infraFiles.push(scannedFile);
    }

    // Parse manifests
    if (scanKind === "manifest" && parseManifests) {
      const manifest = parseManifest(scannedFile);
      if (manifest) {
        manifests.push(manifest);
      }
    }

    // Progress callback
    if (options.onProgress) {
      options.onProgress(i + 1, allEntries.length, relPath);
    }
  }

  // ── Build result ──────────────────────────────────────────────────

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  const stats: ScanStats = {
    totalDiscovered,
    scannedFiles: scannedCount,
    skippedFiles: skippedCount,
    failedFiles: failedCount,
    truncatedFiles: truncatedCount,
    totalBytes,
    totalLines: totalLineCount,
    byKind,
    byExtension,
    manifestCount: manifests.length,
    envFileCount: envFiles.length,
    durationMs,
  };

  return {
    projectRoot,
    projectName,
    files: scannedFiles,
    manifests,
    envFiles,
    dockerfiles,
    cicdFiles,
    infraFiles,
    stats,
    startedAt,
    completedAt,
    warnings,
    complete,
    gitignorePatterns,
  };
}

// ── Single-File Scanner ─────────────────────────────────────────────────────

/**
 * Scan a single file and return its ScannedFile representation.
 *
 * Useful for targeted analysis (e.g. when the user uses @path targeting).
 *
 * @param filePath    - Path to the file.
 * @param projectRoot - The project root (for computing relativePath).
 * @param options     - Optional size/line limits.
 */
export async function scanSingleFile(
  filePath: string,
  projectRoot: string,
  options: {
    maxFileSize?: number;
    maxLines?: number;
  } = {},
): Promise<ScannedFile | null> {
  const absPath = resolve(filePath);
  const relPath = relative(resolve(projectRoot), absPath);
  const name = basename(absPath);
  const ext = extname(absPath).toLowerCase();

  const fileExists = await exists(absPath);
  if (!fileExists) return null;

  const maxFileSize = options.maxFileSize ?? MAX_FILE_SIZE_BYTES;
  const maxLines = options.maxLines ?? MAX_LINES_PER_FILE;

  const readResult = await safeReadFile(absPath, maxFileSize, maxLines);

  if (!readResult.ok) {
    return {
      path: absPath,
      relativePath: relPath,
      name,
      ext,
      kind: classifyScanFile(name, ext, relPath),
      fsKind: classifyFile(absPath),
      content: "",
      lineCount: 0,
      sizeBytes: readResult.sizeBytes ?? 0,
      truncated: false,
      readOk: false,
      readError: readResult.error,
      lines: [],
    };
  }

  const content = readResult.content;
  const lines = content.split("\n");
  const fsKind = classifyFile(absPath);
  const scanKind = classifyScanFile(name, ext, relPath);

  return {
    path: absPath,
    relativePath: relPath,
    name,
    ext,
    kind: scanKind,
    fsKind,
    content,
    lineCount: readResult.lineCount,
    sizeBytes: readResult.sizeBytes ?? 0,
    truncated: readResult.truncated,
    readOk: true,
    lines,
  };
}

/**
 * Scan multiple specific files and return their ScannedFile representations.
 *
 * @param filePaths   - Array of file paths.
 * @param projectRoot - The project root.
 * @param options     - Optional size/line limits.
 */
export async function scanMultipleFiles(
  filePaths: string[],
  projectRoot: string,
  options: {
    maxFileSize?: number;
    maxLines?: number;
  } = {},
): Promise<ScannedFile[]> {
  const results: ScannedFile[] = [];

  for (const fp of filePaths) {
    const scanned = await scanSingleFile(fp, projectRoot, options);
    if (scanned) {
      results.push(scanned);
    }
  }

  return results;
}

// ── File Classification ─────────────────────────────────────────────────────

/**
 * Classify a file into a ScanFileKind based on its name, extension, and
 * relative path.
 */
function classifyScanFile(
  name: string,
  ext: string,
  relativePath: string,
): ScanFileKind {
  const lowerName = name.toLowerCase();
  const lowerExt = ext.toLowerCase();
  const lowerRel = relativePath.toLowerCase();

  // ── Environment files ───────────────────────────────────────────
  if (
    lowerName === ".env" ||
    lowerName.startsWith(".env.") ||
    lowerName === "env" ||
    lowerExt === ".env"
  ) {
    return "env";
  }

  // ── Dockerfiles ─────────────────────────────────────────────────
  if (
    lowerName === "dockerfile" ||
    lowerName.startsWith("dockerfile.") ||
    lowerName === ".dockerignore" ||
    lowerName === "docker-compose.yml" ||
    lowerName === "docker-compose.yaml" ||
    lowerName === "compose.yml" ||
    lowerName === "compose.yaml"
  ) {
    return "dockerfile";
  }

  // ── CI/CD pipelines ─────────────────────────────────────────────
  if (
    lowerRel.startsWith(".github/") ||
    lowerRel.startsWith(".gitlab/") ||
    lowerRel.startsWith(".circleci/") ||
    lowerName === ".gitlab-ci.yml" ||
    lowerName === ".travis.yml" ||
    lowerName === "jenkinsfile" ||
    lowerName === "bitbucket-pipelines.yml" ||
    lowerName === "azure-pipelines.yml" ||
    lowerName === "cloudbuild.yaml" ||
    lowerName === "cloudbuild.yml" ||
    lowerName === ".drone.yml" ||
    lowerName === "appveyor.yml" ||
    lowerName === "buildkite.yml" ||
    lowerRel.startsWith(".buildkite/")
  ) {
    return "cicd";
  }

  // ── Infrastructure-as-code ──────────────────────────────────────
  if (
    lowerExt === ".tf" ||
    lowerExt === ".tfvars" ||
    lowerExt === ".hcl" ||
    lowerName === "serverless.yml" ||
    lowerName === "serverless.yaml" ||
    lowerName === "cdk.json" ||
    lowerName === "sam.yaml" ||
    lowerName === "sam.yml" ||
    lowerName === "template.yaml" ||
    lowerName === "template.yml" ||
    lowerRel.includes("cloudformation") ||
    lowerRel.includes("terraform")
  ) {
    return "infra";
  }

  // ── Lock files ──────────────────────────────────────────────────
  if (
    lowerName === "package-lock.json" ||
    lowerName === "bun.lock" ||
    lowerName === "bun.lockb" ||
    lowerName === "yarn.lock" ||
    lowerName === "pnpm-lock.yaml" ||
    lowerName === "composer.lock" ||
    lowerName === "gemfile.lock" ||
    lowerName === "cargo.lock" ||
    lowerName === "poetry.lock" ||
    lowerName === "pipfile.lock" ||
    lowerName === "pubspec.lock" ||
    lowerName === "go.sum" ||
    lowerName === "packages.lock.json"
  ) {
    return "lockfile";
  }

  // ── Package manifests ───────────────────────────────────────────
  if (
    lowerName === "package.json" ||
    lowerName === "cargo.toml" ||
    lowerName === "go.mod" ||
    lowerName === "requirements.txt" ||
    lowerName === "requirements-dev.txt" ||
    lowerName === "pipfile" ||
    lowerName === "pyproject.toml" ||
    lowerName === "setup.py" ||
    lowerName === "setup.cfg" ||
    lowerName === "pom.xml" ||
    lowerName === "build.gradle" ||
    lowerName === "build.gradle.kts" ||
    lowerName === "composer.json" ||
    lowerName === "gemfile" ||
    lowerName === "pubspec.yaml" ||
    lowerName.endsWith(".csproj") ||
    lowerName.endsWith(".fsproj") ||
    lowerName === "mix.exs" ||
    lowerName === "deno.json" ||
    lowerName === "deno.jsonc" ||
    lowerName === "jsr.json"
  ) {
    return "manifest";
  }

  // ── Source code ─────────────────────────────────────────────────
  if (SOURCE_EXTENSIONS.has(lowerExt)) {
    return "source";
  }

  // ── Configuration files ─────────────────────────────────────────
  if (CONFIG_EXTENSIONS.has(lowerExt)) {
    return "config";
  }

  // ── Markup / templates ──────────────────────────────────────────
  if (MARKUP_EXTENSIONS.has(lowerExt)) {
    return "markup";
  }

  return "unknown";
}

// ── Manifest Parsing ────────────────────────────────────────────────────────

/**
 * Detect the manifest type from a ScannedFile.
 */
function detectManifestType(file: ScannedFile): ManifestType {
  const name = file.name.toLowerCase();

  if (name === "package.json") return "npm";
  if (name === "cargo.toml") return "cargo";
  if (name === "go.mod") return "go";
  if (
    name === "requirements.txt" ||
    name === "requirements-dev.txt" ||
    name === "pipfile" ||
    name === "pyproject.toml" ||
    name === "setup.py" ||
    name === "setup.cfg"
  ) {
    return "pip";
  }
  if (name === "pom.xml") return "maven";
  if (name === "build.gradle" || name === "build.gradle.kts") return "gradle";
  if (name === "composer.json") return "composer";
  if (name === "gemfile") return "gemfile";
  if (name === "pubspec.yaml") return "pubspec";
  if (name.endsWith(".csproj") || name.endsWith(".fsproj")) return "nuget";

  return "unknown";
}

/**
 * Parse a manifest file and extract dependency information.
 *
 * Currently supports full parsing for:
 * - package.json (npm)
 * - requirements.txt (pip)
 * - go.mod (go)
 * - composer.json (composer)
 *
 * Other formats get basic metadata without deep parsing.
 */
function parseManifest(file: ScannedFile): ScannedManifest | null {
  const type = detectManifestType(file);
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  let parsed: Record<string, unknown> | null = null;

  if (!file.content || !file.readOk) {
    return {
      file,
      type,
      dependencies,
      devDependencies,
      parsed: null,
    };
  }

  try {
    switch (type) {
      case "npm":
        parsed = parseNpmManifest(file.content, dependencies, devDependencies);
        break;

      case "pip":
        parsePipManifest(file.content, file.name, dependencies);
        break;

      case "go":
        parseGoMod(file.content, dependencies);
        break;

      case "composer":
        parsed = parseComposerManifest(
          file.content,
          dependencies,
          devDependencies,
        );
        break;

      default:
        // For other formats, just store the raw content for downstream analysis
        break;
    }
  } catch {
    // Parsing failed — return what we have
  }

  return {
    file,
    type,
    dependencies,
    devDependencies,
    parsed,
  };
}

/**
 * Parse package.json and extract dependencies.
 */
function parseNpmManifest(
  content: string,
  deps: Record<string, string>,
  devDeps: Record<string, string>,
): Record<string, unknown> | null {
  try {
    const pkg = JSON.parse(content) as Record<string, unknown>;

    if (pkg["dependencies"] && typeof pkg["dependencies"] === "object") {
      for (const [name, version] of Object.entries(
        pkg["dependencies"] as Record<string, string>,
      )) {
        deps[name] = version;
      }
    }

    if (pkg["devDependencies"] && typeof pkg["devDependencies"] === "object") {
      for (const [name, version] of Object.entries(
        pkg["devDependencies"] as Record<string, string>,
      )) {
        devDeps[name] = version;
      }
    }

    // Also check peerDependencies and optionalDependencies
    for (const field of ["peerDependencies", "optionalDependencies"]) {
      if (pkg[field] && typeof pkg[field] === "object") {
        for (const [name, version] of Object.entries(
          pkg[field] as Record<string, string>,
        )) {
          deps[name] = deps[name] ?? version;
        }
      }
    }

    return pkg;
  } catch {
    return null;
  }
}

/**
 * Parse requirements.txt or Pipfile and extract dependencies.
 */
function parsePipManifest(
  content: string,
  name: string,
  deps: Record<string, string>,
): void {
  const lowerName = name.toLowerCase();

  if (
    lowerName === "requirements.txt" ||
    lowerName === "requirements-dev.txt"
  ) {
    // requirements.txt format: package==version or package>=version
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) {
        continue;
      }

      // Match: package==1.0.0, package>=1.0.0, package~=1.0.0, package
      const match = trimmed.match(
        /^([a-zA-Z0-9_.-]+)\s*([><=!~]+)?\s*([^\s;#]*)?/,
      );
      if (match) {
        const pkgName = match[1]!;
        const version = match[3] || "*";
        deps[pkgName] = `${match[2] || ""}${version}`;
      }
    }
  }
  // Pipfile parsing is more complex (TOML) — basic support
  else if (lowerName === "pipfile") {
    const lines = content.split("\n");
    let inDeps = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed === "[packages]") {
        inDeps = true;
        continue;
      }
      if (trimmed.startsWith("[") && trimmed !== "[packages]") {
        inDeps = false;
        continue;
      }

      if (inDeps && trimmed.includes("=")) {
        const eqIdx = trimmed.indexOf("=");
        const pkgName = trimmed.slice(0, eqIdx).trim();
        const version = trimmed
          .slice(eqIdx + 1)
          .trim()
          .replace(/"/g, "");
        if (pkgName) {
          deps[pkgName] = version;
        }
      }
    }
  }
}

/**
 * Parse go.mod and extract dependencies.
 */
function parseGoMod(content: string, deps: Record<string, string>): void {
  const lines = content.split("\n");
  let inRequireBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "require (") {
      inRequireBlock = true;
      continue;
    }
    if (trimmed === ")" && inRequireBlock) {
      inRequireBlock = false;
      continue;
    }

    // Single-line require: require github.com/pkg/errors v0.9.1
    if (trimmed.startsWith("require ") && !trimmed.includes("(")) {
      const parts = trimmed.slice(8).trim().split(/\s+/);
      if (parts.length >= 2) {
        deps[parts[0]!] = parts[1]!;
      }
      continue;
    }

    // Inside require block: github.com/pkg/errors v0.9.1
    if (inRequireBlock && trimmed && !trimmed.startsWith("//")) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        deps[parts[0]!] = parts[1]!;
      }
    }
  }
}

/**
 * Parse composer.json and extract dependencies.
 */
function parseComposerManifest(
  content: string,
  deps: Record<string, string>,
  devDeps: Record<string, string>,
): Record<string, unknown> | null {
  try {
    const composer = JSON.parse(content) as Record<string, unknown>;

    if (composer["require"] && typeof composer["require"] === "object") {
      for (const [name, version] of Object.entries(
        composer["require"] as Record<string, string>,
      )) {
        // Skip PHP version constraint
        if (name !== "php" && !name.startsWith("ext-")) {
          deps[name] = version;
        }
      }
    }

    if (
      composer["require-dev"] &&
      typeof composer["require-dev"] === "object"
    ) {
      for (const [name, version] of Object.entries(
        composer["require-dev"] as Record<string, string>,
      )) {
        devDeps[name] = version;
      }
    }

    return composer;
  } catch {
    return null;
  }
}

// ── Context Building ────────────────────────────────────────────────────────

/**
 * Build a text context string from scanned files, suitable for sending
 * to an AI model as analysis context.
 *
 * Produces a structured representation:
 *   === FILE: path/to/file.ts (42 lines, 1.2 KB, source) ===
 *   <file content>
 *   === END FILE ===
 *
 * @param files           - The scanned files to include.
 * @param maxTotalChars   - Maximum total characters in the output.
 * @param prioritize      - Optional function to assign priority (higher = included first).
 */
export function buildFileContext(
  files: ScannedFile[],
  maxTotalChars: number = 500_000,
  prioritize?: (file: ScannedFile) => number,
): string {
  // Default prioritization: env > manifest > source > config > markup > others
  const defaultPriority = (f: ScannedFile): number => {
    const kindPriority: Record<ScanFileKind, number> = {
      env: 100,
      manifest: 90,
      dockerfile: 85,
      cicd: 80,
      infra: 75,
      source: 70,
      config: 60,
      lockfile: 20,
      markup: 50,
      unknown: 10,
    };
    return kindPriority[f.kind] ?? 0;
  };

  const getPriority = prioritize ?? defaultPriority;

  // Sort by priority (descending)
  const sorted = [...files].sort((a, b) => getPriority(b) - getPriority(a));

  const parts: string[] = [];
  let totalChars = 0;

  for (const file of sorted) {
    if (totalChars >= maxTotalChars) break;
    if (!file.readOk || !file.content) continue;

    const header = `=== FILE: ${file.relativePath} (${file.lineCount} lines, ${formatBytes(file.sizeBytes)}, ${file.kind}) ===`;
    const footer = `=== END FILE ===`;
    const fileBlock = `${header}\n${file.content}\n${footer}\n\n`;

    if (totalChars + fileBlock.length > maxTotalChars) {
      // Try to include a truncated version
      const remaining = maxTotalChars - totalChars;
      if (remaining > header.length + footer.length + 200) {
        const truncatedContent = file.content.slice(
          0,
          remaining - header.length - footer.length - 50,
        );
        parts.push(
          `${header}\n${truncatedContent}\n... (truncated)\n${footer}\n\n`,
        );
        totalChars = maxTotalChars;
      }
      break;
    }

    parts.push(fileBlock);
    totalChars += fileBlock.length;
  }

  return parts.join("");
}

/**
 * Build a project summary string — a quick overview of the project
 * structure suitable for the AI system prompt.
 */
export function buildProjectSummary(result: ScanResult): string {
  const lines: string[] = [];

  lines.push(`Project: ${result.projectName}`);
  lines.push(`Root: ${result.projectRoot}`);
  lines.push(
    `Files: ${result.stats.scannedFiles} scanned, ` +
      `${result.stats.totalLines} total lines, ` +
      `${formatBytes(result.stats.totalBytes)} total`,
  );
  lines.push("");

  // File type breakdown
  lines.push("File Types:");
  for (const [kind, count] of Object.entries(result.stats.byKind)) {
    if (count > 0) {
      lines.push(`  ${kind}: ${count}`);
    }
  }
  lines.push("");

  // Top extensions
  const topExts = Object.entries(result.stats.byExtension)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  if (topExts.length > 0) {
    lines.push("Top Extensions:");
    for (const [ext, count] of topExts) {
      lines.push(`  ${ext}: ${count}`);
    }
    lines.push("");
  }

  // Manifests
  if (result.manifests.length > 0) {
    lines.push("Detected Manifests:");
    for (const m of result.manifests) {
      const depCount = Object.keys(m.dependencies).length;
      const devDepCount = Object.keys(m.devDependencies).length;
      lines.push(
        `  ${m.file.relativePath} (${m.type}) — ` +
          `${depCount} deps, ${devDepCount} dev deps`,
      );
    }
    lines.push("");
  }

  // .env files (potential risk)
  if (result.envFiles.length > 0) {
    lines.push("Environment Files (potential secrets exposure risk):");
    for (const f of result.envFiles) {
      lines.push(`  ${f.relativePath}`);
    }
    lines.push("");
  }

  // Warnings
  if (result.warnings.length > 0) {
    lines.push(`Warnings: ${result.warnings.length}`);
    for (const w of result.warnings.slice(0, 5)) {
      lines.push(`  - ${w}`);
    }
    if (result.warnings.length > 5) {
      lines.push(`  ... and ${result.warnings.length - 5} more`);
    }
  }

  return lines.join("\n");
}

/**
 * Get a flat list of file paths from a ScanResult, optionally filtered.
 */
export function getFilePaths(
  result: ScanResult,
  filter?: (file: ScannedFile) => boolean,
): string[] {
  let files = result.files;
  if (filter) {
    files = files.filter(filter);
  }
  return files.map((f) => f.relativePath);
}

/**
 * Get files from a ScanResult matching a pattern or kinds.
 */
export function getFilesByKind(
  result: ScanResult,
  ...kinds: ScanFileKind[]
): ScannedFile[] {
  const kindSet = new Set<string>(kinds);
  return result.files.filter((f) => kindSet.has(f.kind));
}

/**
 * Get files from a ScanResult matching an extension.
 */
export function getFilesByExtension(
  result: ScanResult,
  ...extensions: string[]
): ScannedFile[] {
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));
  return result.files.filter((f) => extSet.has(f.ext.toLowerCase()));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Detect the project name from manifests or directory name.
 */
async function detectProjectName(projectRoot: string): Promise<string> {
  // Try package.json
  try {
    const pkgPath = join(projectRoot, "package.json");
    const pkgExists = await exists(pkgPath);
    if (pkgExists) {
      const readResult = await safeReadFile(pkgPath, 50_000, 100);
      if (readResult.ok) {
        const pkg = JSON.parse(readResult.content) as Record<string, unknown>;
        if (typeof pkg["name"] === "string" && pkg["name"]) {
          return pkg["name"] as string;
        }
      }
    }
  } catch {
    // Fall through
  }

  // Try Cargo.toml
  try {
    const cargoPath = join(projectRoot, "Cargo.toml");
    const cargoExists = await exists(cargoPath);
    if (cargoExists) {
      const readResult = await safeReadFile(cargoPath, 50_000, 100);
      if (readResult.ok) {
        const nameMatch = readResult.content.match(/^name\s*=\s*"([^"]+)"/m);
        if (nameMatch?.[1]) {
          return nameMatch[1];
        }
      }
    }
  } catch {
    // Fall through
  }

  // Try go.mod
  try {
    const goModPath = join(projectRoot, "go.mod");
    const goModExists = await exists(goModPath);
    if (goModExists) {
      const readResult = await safeReadFile(goModPath, 10_000, 20);
      if (readResult.ok) {
        const moduleMatch = readResult.content.match(/^module\s+(\S+)/m);
        if (moduleMatch?.[1]) {
          const parts = moduleMatch[1].split("/");
          return parts[parts.length - 1] ?? moduleMatch[1];
        }
      }
    }
  } catch {
    // Fall through
  }

  // Fall back to directory name
  return basename(projectRoot);
}

/**
 * Create an empty ScanResult (for error cases).
 */
function createEmptyScanResult(
  projectRoot: string,
  startedAt: string,
  warnings: string[],
): ScanResult {
  return {
    projectRoot,
    projectName: basename(projectRoot),
    files: [],
    manifests: [],
    envFiles: [],
    dockerfiles: [],
    cicdFiles: [],
    infraFiles: [],
    stats: {
      totalDiscovered: 0,
      scannedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      truncatedFiles: 0,
      totalBytes: 0,
      totalLines: 0,
      byKind: {
        source: 0,
        config: 0,
        markup: 0,
        manifest: 0,
        lockfile: 0,
        dockerfile: 0,
        cicd: 0,
        infra: 0,
        env: 0,
        unknown: 0,
      },
      byExtension: {},
      manifestCount: 0,
      envFileCount: 0,
      durationMs: 0,
    },
    startedAt,
    completedAt: new Date().toISOString(),
    warnings,
    complete: false,
    gitignorePatterns: [],
  };
}

/**
 * Format file size in bytes to a human-readable string.
 * Re-exports from fs utils for convenience.
 */
export { formatBytes } from "../utils/fs.js";
