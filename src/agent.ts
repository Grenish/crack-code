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
  onReasoning?: (delta: string) => void;
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
  providerOptions?: unknown;
  abortSignal?: AbortSignal;
}

// --- helpers: robust reasoning extraction + <think> fallback parsing ---

function extractReasoningDelta(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const e = event as Record<string, unknown>;
  const candidates = [e.textDelta, e.delta, e.text];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "";
}

function parseThinkTaggedDelta(
  delta: string,
  state: { inThink: boolean; carry: string },
): { text: string; reasoning: string } {
  let src = state.carry + delta;
  state.carry = "";

  let textOut = "";
  let reasoningOut = "";

  const openTags = ["<think>", "<thought>", "<thinking>", "<reasoning>"];
  const closeTags = ["</think>", "</thought>", "</thinking>", "</reasoning>"];

  while (src.length > 0) {
    if (state.inThink) {
      // Find the earliest close tag
      let firstCloseIdx = -1;
      let matchedCloseTag = "";
      for (const tag of closeTags) {
        const idx = src.indexOf(tag);
        if (idx !== -1 && (firstCloseIdx === -1 || idx < firstCloseIdx)) {
          firstCloseIdx = idx;
          matchedCloseTag = tag;
        }
      }

      if (firstCloseIdx === -1) {
        // maybe chunk ends with partial close tag
        let keep = "";
        for (const tag of closeTags) {
          const maxPartial = tag.length - 1;
          for (let i = Math.min(maxPartial, src.length); i > 0; i--) {
            const tail = src.slice(-i);
            if (tag.startsWith(tail)) {
              if (tail.length > keep.length) keep = tail;
              break;
            }
          }
        }
        const emit = keep ? src.slice(0, -keep.length) : src;
        reasoningOut += emit;
        state.carry = keep;
        src = "";
      } else {
        reasoningOut += src.slice(0, firstCloseIdx);
        src = src.slice(firstCloseIdx + matchedCloseTag.length);
        state.inThink = false;
      }
    } else {
      let firstOpenIdx = -1;
      let matchedOpenTag = "";
      for (const tag of openTags) {
        const idx = src.indexOf(tag);
        if (idx !== -1 && (firstOpenIdx === -1 || idx < firstOpenIdx)) {
          firstOpenIdx = idx;
          matchedOpenTag = tag;
        }
      }

      if (firstOpenIdx === -1) {
        // maybe chunk ends with partial open tag
        let keep = "";
        for (const tag of openTags) {
          const maxPartial = tag.length - 1;
          for (let i = Math.min(maxPartial, src.length); i > 0; i--) {
            const tail = src.slice(-i);
            if (tag.startsWith(tail)) {
              if (tail.length > keep.length) keep = tail;
              break;
            }
          }
        }
        const emit = keep ? src.slice(0, -keep.length) : src;
        textOut += emit;
        state.carry = keep;
        src = "";
      } else {
        textOut += src.slice(0, firstOpenIdx);
        src = src.slice(firstOpenIdx + matchedOpenTag.length);
        state.inThink = true;
      }
    }
  }

  return { text: textOut, reasoning: reasoningOut };
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
    abortSignal: opts.abortSignal,
    ...(opts.providerOptions ? { providerOptions: opts.providerOptions as any } : {}),
  });

  let stepCount = 0;
  const thinkState = { inThink: false, carry: "" };

  for await (const event of result.fullStream) {
    switch (event.type) {
      case "reasoning-start":
        break;

      case "reasoning-delta": {
        const chunk = (event as { delta?: string }).delta ?? "";
        if (chunk) callbacks.onReasoning?.(chunk);
        break;
      }

      case "reasoning-end":
        break;

      case "text-delta": {
        const raw = extractReasoningDelta(event);
        if (!raw) break;

        // Fallback for providers that stream think tags as normal text
        const { text, reasoning } = parseThinkTaggedDelta(raw, thinkState);
        if (reasoning) callbacks.onReasoning?.(reasoning);
        if (text) callbacks.onText?.(text);
        break;
      }

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

  // Flush any leftover carry safely into current channel
  if (thinkState.carry) {
    if (thinkState.inThink) callbacks.onReasoning?.(thinkState.carry);
    else callbacks.onText?.(thinkState.carry);
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
