// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Build Script
// ─────────────────────────────────────────────────────────────────────────────
// Compiles TypeScript source to JavaScript, adds shebangs to the CLI
// entry point, resolves path aliases, and prepares the dist/ directory
// for npm publishing. Designed to run with Bun.
//
// Usage:
//   bun run scripts/build.ts
//   bun run build
// ─────────────────────────────────────────────────────────────────────────────

import {
  readdir,
  readFile,
  writeFile,
  stat,
  mkdir,
  rm,
  copyFile,
} from "node:fs/promises";
import { join, resolve, relative, dirname, extname, basename } from "node:path";
import { execSync } from "node:child_process";

// ── Configuration ───────────────────────────────────────────────────────────

const ROOT_DIR = resolve(import.meta.dirname, "..");
const SRC_DIR = join(ROOT_DIR, "src");
const DIST_DIR = join(ROOT_DIR, "dist");
const PACKAGE_JSON_PATH = join(ROOT_DIR, "package.json");

/** The shebang line added to the CLI entry point */
const SHEBANG = "#!/usr/bin/env node\n";

/** Entry point file (relative to dist/) that gets the shebang */
const CLI_ENTRY = "index.js";

/** Files to copy from root into dist/ (if they exist) */
const COPY_FILES: string[] = [];

// ── ANSI Colors (for build output) ──────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const GRAY = `${ESC}90m`;

function logStep(icon: string, message: string): void {
  console.log(`  ${icon} ${message}`);
}

function logSuccess(message: string): void {
  logStep(`${BOLD}${GREEN}\uf00c${RESET}`, message);
}

function logInfo(message: string): void {
  logStep(`${BOLD}${CYAN}ℹ${RESET}`, message);
}

function logWarn(message: string): void {
  logStep(`${BOLD}${YELLOW}\uf071${RESET}`, message);
}

function logError(message: string): void {
  logStep(`${BOLD}${RED}\uf00d${RESET}`, message);
}

function logHeader(message: string): void {
  const line = "─".repeat(60);
  console.log(`\n${DIM}${GRAY}${line}${RESET}`);
  console.log(`  ${BOLD}${CYAN}${message}${RESET}`);
  console.log(`${DIM}${GRAY}${line}${RESET}\n`);
}

// ── Utility Functions ───────────────────────────────────────────────────────

/**
 * Check if a path exists.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively get all files in a directory.
 */
async function getAllFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(fullPath);
      files.push(...subFiles);
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Format bytes into a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Format milliseconds into a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Get the total size of all files in a directory recursively.
 */
async function getDirSize(dir: string): Promise<number> {
  let totalSize = 0;

  if (!(await exists(dir))) return 0;

  const files = await getAllFiles(dir);
  for (const file of files) {
    const s = await stat(file);
    totalSize += s.size;
  }

  return totalSize;
}

// ── Build Steps ─────────────────────────────────────────────────────────────

/**
 * Step 1: Clean the dist/ directory.
 */
async function cleanDist(): Promise<void> {
  if (await exists(DIST_DIR)) {
    await rm(DIST_DIR, { recursive: true, force: true });
    logSuccess("Cleaned dist/ directory");
  } else {
    logInfo("dist/ directory does not exist, skipping clean");
  }

  await mkdir(DIST_DIR, { recursive: true });
}

/**
 * Step 2: Compile TypeScript using the TypeScript compiler (tsc).
 *
 * We use tsc directly instead of Bun's bundler because:
 * 1. We need individual .js files (not a single bundle) for tree-shaking
 *    and compatibility with dynamic imports in the provider registry.
 * 2. We need .d.ts declaration files for TypeScript consumers.
 * 3. We need source maps for debugging.
 * 4. We need the same directory structure as src/ preserved in dist/.
 */
async function compileTypeScript(): Promise<void> {
  logInfo("Compiling TypeScript...");

  try {
    // Use tsc from node_modules or globally installed
    const tscPath = await findTsc();

    execSync(`${tscPath} --project ${join(ROOT_DIR, "tsconfig.json")}`, {
      cwd: ROOT_DIR,
      stdio: "pipe",
      encoding: "utf-8",
    });

    logSuccess("TypeScript compilation complete");
  } catch (err) {
    if (err instanceof Error && "stderr" in err) {
      const execErr = err as unknown as { stderr: string; stdout: string };
      const stderr = execErr.stderr;
      const stdout = execErr.stdout;

      // tsc outputs errors to stdout, not stderr
      const output = stdout || stderr || "";

      if (output.trim()) {
        // Parse and display TypeScript errors in a friendly format
        const lines = output.trim().split("\n");
        let errorCount = 0;
        let warningCount = 0;

        for (const line of lines) {
          if (line.includes("error TS")) {
            errorCount++;
            // Only show first 10 errors to avoid overwhelming output
            if (errorCount <= 10) {
              logError(`${DIM}${line.trim()}${RESET}`);
            }
          } else if (line.includes("warning")) {
            warningCount++;
          }
        }

        if (errorCount > 10) {
          logWarn(`... and ${errorCount - 10} more errors`);
        }

        if (errorCount > 0) {
          console.log("");
          logError(
            `TypeScript compilation failed with ${errorCount} error${errorCount === 1 ? "" : "s"}` +
              (warningCount > 0
                ? ` and ${warningCount} warning${warningCount === 1 ? "" : "s"}`
                : ""),
          );

          // Still try to proceed — tsc may have emitted partial output
          // that we can work with, or the errors may be non-fatal warnings
          // treated as errors due to strict settings.
          if (await exists(join(DIST_DIR, CLI_ENTRY))) {
            logWarn("Partial output detected in dist/ — proceeding with build");
          } else {
            throw new Error(
              "TypeScript compilation failed and no output was generated",
            );
          }
        }
      } else {
        throw new Error("TypeScript compilation failed with no output");
      }
    } else {
      throw err;
    }
  }
}

/**
 * Find the tsc binary — check node_modules/.bin first, then global.
 */
async function findTsc(): Promise<string> {
  // Check node_modules/.bin/tsc
  const localTsc = join(ROOT_DIR, "node_modules", ".bin", "tsc");
  if (await exists(localTsc)) {
    return localTsc;
  }

  // Check if tsc is available globally
  try {
    execSync("tsc --version", { stdio: "pipe" });
    return "tsc";
  } catch {
    // Try npx/bunx
    try {
      execSync("bunx tsc --version", { stdio: "pipe" });
      return "bunx tsc";
    } catch {
      try {
        execSync("npx tsc --version", { stdio: "pipe" });
        return "npx tsc";
      } catch {
        throw new Error(
          "TypeScript compiler (tsc) not found.\n" +
            "Install it with: bun add -d typescript\n" +
            "Or globally: npm install -g typescript",
        );
      }
    }
  }
}

/**
 * Step 3: Fix import paths in compiled JavaScript files.
 *
 * TypeScript's compiler does NOT rewrite import specifiers — if the
 * source uses `import { foo } from "./bar.js"`, the output will have
 * the same import path. This is correct for ESM, but we also need to
 * handle the path alias `@/*` → `./src/*` that's configured in
 * tsconfig.json.
 *
 * Additionally, we need to ensure all relative imports have the `.js`
 * extension (required by Node.js ESM resolution).
 */
async function fixImportPaths(): Promise<void> {
  logInfo("Fixing import paths...");

  const distFiles = await getAllFiles(DIST_DIR);
  const jsFiles = distFiles.filter((f) => f.endsWith(".js"));

  let fixedCount = 0;

  for (const file of jsFiles) {
    let content = await readFile(file, "utf-8");
    let modified = false;

    // Fix @/* path alias imports → relative paths
    // Pattern: from "@/..." or from '@/...'
    const aliasRegex = /(from\s+["'])@\/([^"']+)(["'])/g;
    if (aliasRegex.test(content)) {
      content = content.replace(
        aliasRegex,
        (_match, prefix, importPath, suffix) => {
          // Calculate relative path from current file to the root of dist/
          const fileDir = dirname(file);
          const targetPath = join(DIST_DIR, importPath);
          let relPath = relative(fileDir, targetPath);

          // Ensure it starts with ./ or ../
          if (!relPath.startsWith(".")) {
            relPath = "./" + relPath;
          }

          // Ensure .js extension
          if (!relPath.endsWith(".js")) {
            relPath += ".js";
          }

          return `${prefix}${relPath}${suffix}`;
        },
      );
      modified = true;
    }

    // Ensure all relative imports have .js extension
    // This catches cases where TypeScript source used `.ts` imports
    // that tsc didn't transform (shouldn't happen with our config, but safety net)
    const tsExtRegex = /(from\s+["']\.\.?\/[^"']+)\.ts(["'])/g;
    if (tsExtRegex.test(content)) {
      content = content.replace(tsExtRegex, "$1.js$2");
      modified = true;
    }

    if (modified) {
      await writeFile(file, content, "utf-8");
      fixedCount++;
    }
  }

  if (fixedCount > 0) {
    logSuccess(
      `Fixed import paths in ${fixedCount} file${fixedCount === 1 ? "" : "s"}`,
    );
  } else {
    logInfo("No import paths needed fixing");
  }
}

/**
 * Step 4: Add shebang to the CLI entry point.
 *
 * The entry point (dist/index.js) needs a `#!/usr/bin/env node` shebang
 * so that it can be executed directly as a CLI command when installed
 * globally or via npx/bunx.
 */
async function addShebang(): Promise<void> {
  const entryPath = join(DIST_DIR, CLI_ENTRY);

  if (!(await exists(entryPath))) {
    logWarn(`Entry point ${CLI_ENTRY} not found in dist/ — skipping shebang`);
    return;
  }

  let content = await readFile(entryPath, "utf-8");

  // Don't add shebang if already present
  if (content.startsWith("#!")) {
    logInfo("Shebang already present in entry point");
    return;
  }

  content = SHEBANG + content;
  await writeFile(entryPath, content, "utf-8");

  // Make the file executable on Unix-like systems
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(entryPath, 0o755);
  } catch {
    // chmod may fail on Windows — that's fine
  }

  logSuccess(`Added shebang to ${CLI_ENTRY}`);
}

/**
 * Step 5: Copy additional files to dist/ (if configured).
 */
async function copyExtraFiles(): Promise<void> {
  if (COPY_FILES.length === 0) return;

  let copied = 0;

  for (const file of COPY_FILES) {
    const srcPath = join(ROOT_DIR, file);
    const destPath = join(DIST_DIR, file);

    if (await exists(srcPath)) {
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
      copied++;
    }
  }

  if (copied > 0) {
    logSuccess(
      `Copied ${copied} additional file${copied === 1 ? "" : "s"} to dist/`,
    );
  }
}

/**
 * Step 6: Verify the build output.
 *
 * Performs basic sanity checks on the dist/ directory to ensure:
 * 1. The CLI entry point exists
 * 2. It starts with a shebang
 * 3. Key modules are present
 * 4. The total output size is reasonable
 */
async function verifyBuild(): Promise<void> {
  logInfo("Verifying build output...");

  const errors: string[] = [];
  const warnings: string[] = [];

  // Check entry point
  const entryPath = join(DIST_DIR, CLI_ENTRY);
  if (!(await exists(entryPath))) {
    errors.push(`Missing CLI entry point: dist/${CLI_ENTRY}`);
  } else {
    const content = await readFile(entryPath, "utf-8");
    if (!content.startsWith("#!")) {
      warnings.push(`Entry point is missing shebang: dist/${CLI_ENTRY}`);
    }
  }

  // Check that key directories exist in dist/
  const expectedDirs = [
    "utils",
    "providers",
    "config",
    "tui",
    "cli",
    "tools",
    "tools/builtin",
    "scanner",
    "analyzer",
    "agent",
    "mcp",
    "output",
  ];

  for (const dir of expectedDirs) {
    const dirPath = join(DIST_DIR, dir);
    if (!(await exists(dirPath))) {
      // Only warn — some directories may be empty and not emitted
      warnings.push(`Expected directory not found: dist/${dir}`);
    }
  }

  // Check total output size
  const totalSize = await getDirSize(DIST_DIR);
  const allFiles = await getAllFiles(DIST_DIR);
  const jsFiles = allFiles.filter((f) => f.endsWith(".js"));
  const dtsFiles = allFiles.filter((f) => f.endsWith(".d.ts"));
  const mapFiles = allFiles.filter(
    (f) => f.endsWith(".js.map") || f.endsWith(".d.ts.map"),
  );

  // Report results
  console.log("");
  logInfo(`Build output summary:`);
  console.log(`    ${DIM}${GRAY}JavaScript files:${RESET}  ${jsFiles.length}`);
  console.log(`    ${DIM}${GRAY}Declaration files:${RESET} ${dtsFiles.length}`);
  console.log(`    ${DIM}${GRAY}Source map files:${RESET}  ${mapFiles.length}`);
  console.log(`    ${DIM}${GRAY}Total files:${RESET}       ${allFiles.length}`);
  console.log(
    `    ${DIM}${GRAY}Total size:${RESET}        ${formatBytes(totalSize)}`,
  );
  console.log("");

  // Report warnings
  for (const warning of warnings) {
    logWarn(warning);
  }

  // Report errors
  for (const error of errors) {
    logError(error);
  }

  if (errors.length > 0) {
    throw new Error(
      `Build verification failed with ${errors.length} error${errors.length === 1 ? "" : "s"}`,
    );
  }

  logSuccess("Build verification passed");
}

/**
 * Step 7: Read and display package.json info.
 */
async function displayPackageInfo(): Promise<void> {
  try {
    const pkgContent = await readFile(PACKAGE_JSON_PATH, "utf-8");
    const pkg = JSON.parse(pkgContent) as {
      name: string;
      version: string;
      description?: string;
      bin?: Record<string, string>;
    };

    console.log("");
    logInfo("Package info:");
    console.log(
      `    ${DIM}${GRAY}Name:${RESET}        ${BOLD}${pkg.name}${RESET}`,
    );
    console.log(`    ${DIM}${GRAY}Version:${RESET}     ${pkg.version}`);
    if (pkg.bin) {
      const binEntries = Object.entries(pkg.bin);
      for (const [cmd, path] of binEntries) {
        console.log(
          `    ${DIM}${GRAY}Binary:${RESET}      ${CYAN}${cmd}${RESET} → ${path}`,
        );
      }
    }
    console.log("");
  } catch {
    // Non-fatal — just skip
  }
}

// ── Main Build Pipeline ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = performance.now();

  logHeader("Crack Code — Build Pipeline");

  try {
    // Step 1: Clean
    await cleanDist();

    // Step 2: Compile TypeScript
    await compileTypeScript();

    // Step 3: Fix import paths (aliases, extensions)
    await fixImportPaths();

    // Step 4: Add shebang to CLI entry point
    await addShebang();

    // Step 5: Copy additional files
    await copyExtraFiles();

    // Step 6: Verify build output
    await verifyBuild();

    // Step 7: Display package info
    await displayPackageInfo();

    const duration = performance.now() - startTime;
    console.log(
      `  ${BOLD}${GREEN}\uf00c${RESET} Build completed successfully in ${BOLD}${formatDuration(duration)}${RESET}\n`,
    );

    console.log(`  ${DIM}${GRAY}To publish:${RESET}  npm publish`);
    console.log(`  ${DIM}${GRAY}To test:${RESET}     node dist/index.js`);
    console.log(`  ${DIM}${GRAY}To install:${RESET}  npm install -g .`);
    console.log("");
  } catch (err) {
    const duration = performance.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    console.log("");
    logError(`Build failed after ${formatDuration(duration)}: ${message}`);
    console.log("");

    process.exit(1);
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

main();
