import type { ModelInfo } from "./types";
import { isLikelyTextGenerationModel, normalizeModels } from "./utils";

export async function fetchOpenRouterModels(
  apiKey: string,
): Promise<ModelInfo[]> {
  const res = await fetch(
    "https://openrouter.ai/api/v1/models?output_modalities=text",
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );

  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as {
    data: Array<{ id: string; name?: string }>;
  };

  return normalizeModels(
    data.data
      .filter((model) => isLikelyTextGenerationModel(model.id))
      .map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
      })),
  );
}
