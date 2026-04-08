import { resolve, relative } from "node:path";
import { existsSync } from "node:fs";

export interface TerminalState {
  cwd: string;
  env: Record<string, string>;
  history: string[];
}

export class VirtualTerminal {
  private cwd: string;
  private env: Record<string, string>;
  private history: string[] = [];
  private projectRoot: string;
  private maxHistorySize: number = 100;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = resolve(projectRoot);
    this.cwd = this.projectRoot;
    // Initialize env with process.env copy, filtering out undefined values
    this.env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        this.env[key] = value;
      }
    }
  }

  /**
   * Get current working directory
   */
  getCwd(): string {
    return this.cwd;
  }

  /**
   * Change directory - validates it's within project root
   */
  changeDir(path: string): {
    success: boolean;
    error?: string;
    newCwd?: string;
  } {
    const abs = resolve(this.cwd, path);
    const rel = relative(this.projectRoot, abs);

    // Block path traversal outside project root
    if (rel.startsWith("..")) {
      return {
        success: false,
        error: `Cannot cd outside project root. Attempted: ${path}`,
      };
    }

    // Check if directory exists
    if (!existsSync(abs)) {
      return {
        success: false,
        error: `Directory not found: ${path}`,
      };
    }

    this.cwd = abs;
    return { success: true, newCwd: this.cwd };
  }

  /**
   * Get all environment variables
   */
  getEnv(): Record<string, string> {
    return { ...this.env };
  }

  /**
   * Set an environment variable
   */
  setEnv(key: string, value: string): void {
    this.env[key] = value;
  }

  /**
   * Get a specific environment variable
   */
  getEnvVar(key: string): string | undefined {
    return this.env[key];
  }

  /**
   * Delete an environment variable
   */
  deleteEnv(key: string): boolean {
    if (key in this.env) {
      delete this.env[key];
      return true;
    }
    return false;
  }

  /**
   * Add command to history (with size limit)
   */
  addToHistory(command: string): void {
    this.history.push(command);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }

  /**
   * Get command history
   */
  getHistory(): string[] {
    return [...this.history];
  }

  /**
   * Get recent commands
   */
  getRecentHistory(count: number = 10): string[] {
    return this.history.slice(Math.max(0, this.history.length - count));
  }

  /**
   * Clear history
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Get current state snapshot
   */
  getState(): TerminalState {
    return {
      cwd: this.cwd,
      env: { ...this.env },
      history: [...this.history],
    };
  }

  /**
   * Reset to initial state
   */
  reset(): void {
    this.cwd = this.projectRoot;
    this.env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        this.env[key] = value;
      }
    }
    this.history = [];
  }

  /**
   * Get project root
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  /**
   * Get relative path from project root
   */
  getRelativePath(absolutePath: string): string {
    return relative(this.projectRoot, resolve(absolutePath));
  }

  /**
   * Check if a path is within project root
   */
  isPathInProject(path: string): boolean {
    const abs = resolve(this.cwd, path);
    const rel = relative(this.projectRoot, abs);
    return !rel.startsWith("..");
  }
}

// Global instance - shared across all tool invocations in a session
let globalTerminal: VirtualTerminal | null = null;

/**
 * Get or create the global virtual terminal instance
 */
export function getGlobalTerminal(projectRoot?: string): VirtualTerminal {
  if (!globalTerminal) {
    globalTerminal = new VirtualTerminal(projectRoot);
  }
  return globalTerminal;
}

/**
 * Reset the global virtual terminal (useful for testing or starting fresh)
 */
export function resetGlobalTerminal(): void {
  if (globalTerminal) {
    globalTerminal.reset();
  }
}

/**
 * Destroy the global virtual terminal instance
 */
export function destroyGlobalTerminal(): void {
  globalTerminal = null;
}
