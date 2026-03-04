import type { LanguageModel } from "ai";
import type { Config } from "./config";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOllama } from "ollama-ai-provider-v2";

/**
 * Takes a provider name, model string, and API key from config
 * and returns an AI SDK LanguageModelV1 that streamText() can use.
 *
 * We use factory functions (createAnthropic, createOpenAI, etc.) instead
 * of the default exports because the user's API key lives in
 * ~/.crack-code/config.json, not necessarily in env vars.
 */
export function getModel(
  provider: Config["provider"],
  model: string,
  apiKey: string,
): LanguageModel {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(model);

    case "openai":
      return createOpenAI({ apiKey })(model);

    case "google":
      return createGoogleGenerativeAI({ apiKey })(model);

    case "ollama":
      // For ollama the "apiKey" field holds the endpoint URL
      return createOllama({ baseURL: apiKey || undefined })(model);

    default:
      throw new Error(`Unknown provider: "${provider}"`);
  }
}
