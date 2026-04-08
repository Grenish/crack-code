import type { ModelInfo } from "./types";
import { normalizeModels } from "./utils";

interface AnthropicModelsResponse {
  data: Array<{ id: string; display_name?: string }>;
  has_more?: boolean;
  last_id?: string;
}

export async function fetchAnthropicModels(
  apiKey: string,
): Promise<ModelInfo[]> {
  const models: Array<{ id: string; name?: string }> = [];
  let afterId: string | undefined;

  while (true) {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", "1000");

    if (afterId) {
      url.searchParams.set("after_id", afterId);
    }

    const res = await fetch(url, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });

    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

    const data = (await res.json()) as AnthropicModelsResponse;

    models.push(
      ...data.data.map((model) => ({
        id: model.id,
        name: model.display_name ?? model.id,
      })),
    );

    if (!data.has_more || !data.last_id) {
      break;
    }

    afterId = data.last_id;
  }

  return normalizeModels(models);
}
