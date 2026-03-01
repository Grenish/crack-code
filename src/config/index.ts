import Conf from "conf";
import { z } from "zod";

export const configSchema = z.object({
  name: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  setupComplete: z.boolean().default(false),
});

export type ConfigSchema = z.infer<typeof configSchema>;

export const config = new Conf<ConfigSchema>({
  projectName: "crack-code",
  schema: {
    name: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    setupComplete: { type: "boolean", default: false },
  },
});
