import type { ModelInfo } from "./types";
import { normalizeModels, stripPrefix } from "./utils";

interface GoogleModelListResponse {
  models?: Array<{
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
  }>;
  nextPageToken?: string;
}

export async function fetchGoogleModels(apiKey: string): Promise<ModelInfo[]> {
  const models: Array<{ id: string | null; name?: string }> = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ pageSize: "1000" });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?${params.toString()}`,
      {
        headers: { "x-goog-api-key": apiKey },
      },
    );

    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

    const data = (await res.json()) as GoogleModelListResponse;

    for (const model of data.models ?? []) {
      if (!model.supportedGenerationMethods?.includes("generateContent")) {
        continue;
      }

      const id = stripPrefix(model.name, "models/");
      if (!id) continue;

      models.push({
        id,
        name: model.displayName ?? id,
      });
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  return normalizeModels(models);
}
