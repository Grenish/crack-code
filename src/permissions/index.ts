import * as readline from "node:readline";
import * as ui from "../ui/renderer.js";

export type PermissionPolicy = "ask" | "skip" | "allow-all" | "deny-all";

export class PermissionManager {
  private policy: PermissionPolicy;
  private sessionApprovals = new Set<string>();

  private readonly readOnlyTools = new Set(["read_file", "list_files"]);

  constructor(policy: PermissionPolicy = "ask") {
    this.policy = policy;
  }

  getPolicy(): PermissionPolicy {
    return this.policy;
  }

  setPolicy(policy: PermissionPolicy): void {
    this.policy = policy;
  }

  async check(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.readOnlyTools.has(toolName)) {
      return true;
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
        // Check session memory before prompting
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
    // Blanket tool approval (user chose "always")
    if (this.sessionApprovals.has(`tool:${toolName}`)) {
      return true;
    }
    // Exact action approval (user chose "yes" for this specific call)
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

    const answer = await this.ask(
      "\x1b[90m│\x1b[0m\x1b[33m   [y]es / [n]o / [a]lways for this session:\x1b[0m ",
    );

    const choice = answer.toLowerCase();

    if (choice === "y" || choice === "yes") {
      // Remember this exact action
      this.sessionApprovals.add(`exact:${toolName}:${JSON.stringify(input)}`);
      return true;
    }

    if (choice === "a" || choice === "always") {
      // Remember all future calls to this tool
      this.sessionApprovals.add(`tool:${toolName}`);
      return true;
    }

    // Anything else is a deny — empty input, "n", "no", gibberish
    ui.toolBlocked(toolName, "Denied by user.");
    return false;
  }

  private summarize(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case "write_file":
        return `Write to ${input.path}`;
      case "run_command":
        return `$ ${input.command}`;
      default:
        const preview = JSON.stringify(input);
        return preview.length > 150 ? preview.slice(0, 150) + "…" : preview;
    }
  }

  private ask(question: string): Promise<string> {
    return new Promise((resolve) => {
      process.stdout.write(question);

      const onData = (data: Buffer) => {
        const char = data.toString();

        // Handle Ctrl+C
        if (char === "\u0003") {
          process.stdout.write("\n");
          process.exit(0);
        }

        process.stdout.write(char + "\n");
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        resolve(char.trim());
      };

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.on("data", onData);
    });
  }
}
