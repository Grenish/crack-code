import type { ModelInfo } from "./types";
import { isLikelyTextGenerationModel, normalizeModels } from "./utils";

interface OpenAIModel {
  id: string;
  created?: number;
}

interface OpenAIModelsResponse {
  data?: OpenAIModel[];
}

export async function fetchOpenAIModels(apiKey: string): Promise<ModelInfo[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as OpenAIModelsResponse;

  const preferredPrefixes = [
    "gpt-",
    "o1",
    "o3",
    "o4",
    "o5",
    "chatgpt-",
  ] as const;
  const excludedTerms = [
    "embed",
    "embedding",
    "image",
    "audio",
    "speech",
    "transcrib",
    "tts",
    "whisper",
    "moderation",
    "rerank",
    "search",
    "realtime",
    "instruct",
  ] as const;

  const models = (data.data ?? [])
    .filter((model) =>
      isLikelyTextGenerationModel(model.id, {
        includePrefixes: preferredPrefixes,
        excludeTerms: excludedTerms,
      }),
    )
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((model) => ({
      id: model.id,
      name: model.id,
    }));

  return normalizeModels(models);
}
