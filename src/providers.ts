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
