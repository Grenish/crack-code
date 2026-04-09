import * as ui from "../ui/renderer.js";

export type PermissionPolicy = "ask" | "skip" | "allow-all" | "deny-all";

export class PermissionManager {
  private policy: PermissionPolicy;
  private allowEdits: boolean;
  private sessionApprovals = new Set<string>();

  private readonly readOnlyTools = new Set(["read_file", "list_files"]);

  constructor(policy: PermissionPolicy = "ask", allowEdits = false) {
    this.policy = policy;
    this.allowEdits = allowEdits;
  }

  getPolicy(): PermissionPolicy {
    return this.policy;
  }

  setPolicy(policy: PermissionPolicy): void {
    this.policy = policy;
  }

  getEditMode(): boolean {
    return this.allowEdits;
  }

  setEditMode(allowEdits: boolean): void {
    this.allowEdits = allowEdits;
  }

  async check(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.readOnlyTools.has(toolName)) {
      return true;
    }

    if (!this.allowEdits) {
      ui.toolBlocked(toolName, "Blocked by read-only mode.");
      return false;
    }

    switch (this.policy) {
      case "allow-all":
        return true;

      case "deny-all":
        ui.toolBlocked(toolName, "Blocked by deny-all policy.");
        return false;

      case "skip":
        return true;

      case "ask":
        if (this.isSessionApproved(toolName, input)) {
          return true;
        }
        return this.promptUser(toolName, input);
    }
  }

  clearSession(): void {
    this.sessionApprovals.clear();
  }

  private isSessionApproved(
    toolName: string,
    input: Record<string, unknown>,
  ): boolean {
    if (this.sessionApprovals.has(`tool:${toolName}`)) {
      return true;
    }

    if (
      this.sessionApprovals.has(`exact:${toolName}:${JSON.stringify(input)}`)
    ) {
      return true;
    }

    return false;
  }

  private async promptUser(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    const summary = this.summarize(toolName, input);
    ui.permissionPrompt(toolName, summary);

    const answer = await this.askChoice(
      "\x1b[90m  ╰─\x1b[0m \x1b[33mChoose \x1b[32m[y]\x1b[33mes / \x1b[31m[n]\x1b[33mo / \x1b[36m[a]\x1b[33mlways:\x1b[0m ",
      ["y", "n", "a"],
    );

    if (answer === "y") {
      this.sessionApprovals.add(`exact:${toolName}:${JSON.stringify(input)}`);
      return true;
    }

    if (answer === "a") {
      this.sessionApprovals.add(`tool:${toolName}`);
      return true;
    }

    ui.toolBlocked(toolName, "Denied by user.");
    return false;
  }

  private summarize(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case "write_file":
        return `Write to ${input.path}`;
      case "run_command":
        return `$ ${input.command}`;
      default: {
        const preview = JSON.stringify(input);
        return preview.length > 150 ? preview.slice(0, 150) + "…" : preview;
      }
    }
  }

  private async askChoice(
    question: string,
    allowed: readonly string[],
  ): Promise<string> {
    const normalizedAllowed = new Set(allowed.map((v) => v.toLowerCase()));
    const stdin = process.stdin;
    const stdout = process.stdout;

    const wasRaw = Boolean((stdin as any).isRaw);
    const wasPaused = stdin.isPaused();

    // Drain any pending buffered input (e.g., Enter from prior prompt)
    try {
      let drained = stdin.read();
      while (drained !== null) {
        drained = stdin.read();
      }
    } catch {
      // no-op
    }

    return await new Promise<string>((resolve) => {
      let done = false;
      let buffer = "";

      const cleanup = () => {
        if (done) return;
        done = true;

        stdin.removeListener("data", onData);
        stdin.removeListener("end", onEnd);
        stdin.removeListener("error", onError);

        if (stdin.isTTY) {
          try {
            stdin.setRawMode(wasRaw);
          } catch {
            // no-op
          }
        }

        if (wasPaused) {
          stdin.pause();
        }
      };

      const finish = (value: string) => {
        cleanup();
        resolve(value);
      };

      const finalizeBuffer = () => {
        const trimmed = buffer.trim().toLowerCase();
        if (trimmed.length > 0) {
          const first = trimmed[0]!;
          if (normalizedAllowed.has(first)) {
            stdout.write(`${first}\n`);
            finish(first);
            return;
          }
          if (trimmed === "yes" && normalizedAllowed.has("y")) {
            stdout.write("y\n");
            finish("y");
            return;
          }
          if (trimmed === "no" && normalizedAllowed.has("n")) {
            stdout.write("n\n");
            finish("n");
            return;
          }
          if (trimmed === "always" && normalizedAllowed.has("a")) {
            stdout.write("a\n");
            finish("a");
            return;
          }
        }

        stdout.write("n\n");
        finish("n");
      };

      const onData = (chunk: Buffer | string) => {
        const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");

        // Ctrl+C
        if (s.includes("\u0003")) {
          stdout.write("\n");
          cleanup();
          process.exit(0);
        }

        // In raw mode, single keypress should be handled once and immediately.
        if (stdin.isTTY) {
          const c = s.toLowerCase();

          if (c === "y" || c === "n" || c === "a") {
            stdout.write(`${c}\n`);
            finish(c);
            return;
          }

          if (c === "\r" || c === "\n") {
            stdout.write("n\n");
            finish("n");
            return;
          }

          if (c === "\u007f" || c === "\b") {
            // Ignore backspace in single-key mode.
            return;
          }

          // Ignore other keys in raw mode.
          return;
        }

        // Non-TTY fallback: buffered line input.
        buffer += s;
        if (s.includes("\n") || s.includes("\r")) {
          finalizeBuffer();
        }
      };

      const onEnd = () => {
        stdout.write("\n");
        finish("n");
      };

      const onError = () => {
        stdout.write("\n");
        finish("n");
      };

      stdout.write(question);

      if (stdin.isTTY) {
        try {
          stdin.setRawMode(true);
        } catch {
          // Fall through; non-raw still works via data buffering path.
        }
      }

      stdin.resume();
      stdin.on("data", onData);
      stdin.once("end", onEnd);
      stdin.once("error", onError);
    });
  }
}
