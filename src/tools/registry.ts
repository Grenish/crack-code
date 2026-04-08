import type { ToolSet } from "ai";
import type { z } from "zod";
import type { PermissionManager } from "../permissions/index.js";

// Each tool module exports one of these
export interface ToolDef<
  TSchema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> {
  name: string;
  description: string;
  inputSchema: TSchema;
  requiresApproval: boolean;
  execute: (input: z.infer<TSchema>) => Promise<string>;
}

export class ToolRegistry {
  private defs: ToolDef[] = [];

  register(def: ToolDef): void {
    this.defs.push(def);
  }

  registerAll(...defs: ToolDef[]): void {
    for (const def of defs) this.defs.push(def);
  }

  // Convert to AI SDK ToolSet with permission gating and UI hooks
  toAISDKTools(permissions: PermissionManager): ToolSet {
    const tools: ToolSet = {};

    for (const def of this.defs) {
      tools[def.name] = {
        description: def.description,
        inputSchema: def.inputSchema,
        execute: async (input: Record<string, unknown>) => {
          if (def.requiresApproval) {
            const allowed = await permissions.check(def.name, input);
            if (!allowed) return "⛔ Tool call denied by user.";
          }

          try {
            const result = await def.execute(input);
            return result;
          } catch (err: any) {
            const msg = `Error: ${err.message ?? err}`;
            return msg;
          }
        },
      };
    }

    return tools;
  }

  getNames(): string[] {
    return this.defs.map((d) => d.name);
  }
}
