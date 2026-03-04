import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type LanguageModel,
} from "ai";
import type { ToolRegistry } from "./tools/registry.js";
import type { PermissionManager } from "./permissions/index.js";

// --- Types ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AgentCallbacks {
  onText?: (delta: string) => void;
  onToolStart?: (name: string, input: unknown) => void;
  onToolEnd?: (name: string, result: string) => void;
  onStepComplete?: (stepNumber: number) => void;
  onUsage?: (usage: TokenUsage) => void;
  onError?: (error: string) => void;
}

export interface AgentOptions {
  model: LanguageModel;
  tools: ToolRegistry;
  permissions: PermissionManager;
  systemPrompt: string;
  maxSteps?: number;
  maxTokens?: number;
}

// --- Agent ---

export async function runAgent(
  messages: ModelMessage[],
  opts: AgentOptions,
  callbacks: AgentCallbacks = {},
): Promise<ModelMessage[]> {
  const sdkTools = opts.tools.toAISDKTools(opts.permissions);

  const result = streamText({
    model: opts.model,
    system: opts.systemPrompt,
    messages,
    tools: sdkTools,
    stopWhen: stepCountIs(opts.maxSteps ?? 30),
    maxOutputTokens: opts.maxTokens ?? 16384,
  });

  let stepCount = 0;

  for await (const event of result.fullStream) {
    switch (event.type) {
      case "text-delta":
        callbacks.onText?.(event.text);
        break;

      case "tool-call":
        callbacks.onToolStart?.(event.toolName, event.input);
        break;

      case "tool-result": {
        const text =
          typeof event.output === "string"
            ? event.output
            : JSON.stringify(event.output);
        callbacks.onToolEnd?.(event.toolName, text);
        break;
      }

      case "finish-step":
        stepCount++;
        callbacks.onStepComplete?.(stepCount);
        break;

      case "error":
        callbacks.onError?.(
          event.error instanceof Error
            ? event.error.message
            : String(event.error),
        );
        break;
    }
  }

  // Resolve final usage across all steps
  const usage = await result.usage;
  if (usage) {
    callbacks.onUsage?.({
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    });
  }

  // Return full conversation including AI responses and tool results
  // so the REPL can maintain context across turns
  const response = await result.response;
  return [...messages, ...response.messages];
}
