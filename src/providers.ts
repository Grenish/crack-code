import type { LanguageModel } from "ai";
import type { Config } from "./config";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createOllama } from "ollama-ai-provider-v2";

// Accepts the full config so Azure/Vertex can read their extra fields
// (resourceName, project, location) from stored config.
export function getModel(config: Config): LanguageModel {
  const { provider, model, apiKey } = config;

  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(model);

    case "azure":
      return createAzure({
        resourceName: config.resourceName ?? process.env.AZURE_RESOURCE_NAME,
        apiKey,
      })(model);

    case "openai":
      return createOpenAI({ apiKey })(model);

    case "google":
      return createGoogleGenerativeAI({ apiKey })(model);

    case "openrouter":
      return createOpenAI({
        apiKey,
        baseURL: "https://openrouter.ai/api/v1",
        headers: {
          "HTTP-Referer": "https://github.com/grenishrai/crack-code",
          "X-OpenRouter-Title": "crack-code",
        },
      }).chat(model);

    case "ollama": {
      // For ollama the "apiKey" field holds the endpoint URL.
      // Normalize to include `/api` so chat requests go to `/api/chat`
      // instead of `/chat` (which returns 404 on Ollama).
      const rawBaseURL = (apiKey || "").trim();
      const normalizedBaseURL = rawBaseURL
        ? rawBaseURL.replace(/\/+$/, "").replace(/\/api$/, "") + "/api"
        : undefined;

      return createOllama({ baseURL: normalizedBaseURL })(model);
    }

    case "vertex": {
      const vertexOptions: Record<string, unknown> = {
        project: config.project ?? process.env.GOOGLE_CLOUD_PROJECT,
        location:
          config.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
      };

      // Use service account credentials if available
      if (config.vertexClientEmail && config.vertexPrivateKey) {
        vertexOptions.googleAuthOptions = {
          credentials: {
            client_email: config.vertexClientEmail,
            private_key: config.vertexPrivateKey,
          },
        };
      }

      return createVertex(vertexOptions)(model);
    }

    default:
      throw new Error(`Unknown provider: "${provider}"`);
  }
}

/**
 * Build provider-specific options for reasoning/thinking support.
 * Different providers have different mechanisms for enabling extended reasoning.
 */
export function buildProviderOptions(config: Config): unknown {
  const options: Record<string, unknown> = {};

  // Default thinking budget if not specified (in tokens)
  const budget = config.thinkingBudget ?? 8000;

  switch (config.provider) {
    case "anthropic": {
      // Anthropic Claude models support extended thinking with budgetTokens
      // Models: claude-opus-4-20250514, claude-sonnet-4-20250514, claude-sonnet-4-5-20250929
      options.anthropic = {
        thinking: {
          type: "enabled",
          budgetTokens: Math.min(budget, 120000), // Anthropic has upper limits
        },
      };
      break;
    }

    case "openai": {
      // OpenAI o3/o1 models use reasoningEffort parameter
      // Map budget to effort level: low < medium < high < xhigh
      let effort: "low" | "medium" | "high" | "xhigh" = "medium";
      if (budget > 15000) {
        effort = "xhigh";
      } else if (budget > 10000) {
        effort = "high";
      } else if (budget > 5000) {
        effort = "medium";
      } else {
        effort = "low";
      }

      options.openai = {
        reasoningEffort: effort,
        reasoningSummary: "auto",
      };
      break;
    }

    case "vertex": {
      // Google Vertex Gemini models support thinkingConfig
      // thinkingBudget in tokens
      options.vertex = {
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: Math.min(budget, 10000), // Gemini thinkingBudget limit
        },
      };
      break;
    }

    case "google": {
      // Google Generative AI (non-Vertex) has limited reasoning support
      // Most models don't expose thinking through this SDK yet
      break;
    }

    case "openrouter": {
      // OpenRouter proxies to various upstream providers
      // Enable options for all potential providers so they work regardless of model

      // If the model is Anthropic-backed, these will be used
      options.anthropic = {
        thinking: {
          type: "enabled",
          budgetTokens: Math.min(budget, 120000),
        },
      };

      // If the model is OpenAI-backed, these will be used
      const effort: "low" | "medium" | "high" | "xhigh" =
        budget > 10000 ? "high" : budget > 5000 ? "medium" : "low";
      options.openai = {
        reasoningEffort: effort,
      };

      break;
    }

    case "azure": {
      // Azure can host various models; if it's Claude, enable thinking
      options.anthropic = {
        thinking: {
          type: "enabled",
          budgetTokens: Math.min(budget, 120000),
        },
      };
      break;
    }

    case "ollama": {
      // Ollama typically runs open-source models that don't support structured reasoning
      // However, some models like DeepSeek variants may use <think> tags in output
      // No special provider options needed
      break;
    }

    default:
      break;
  }

  return options;
}
