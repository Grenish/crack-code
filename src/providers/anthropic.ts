import type { ModelInfo } from "./types";

export async function fetchAnthropicModels(
  apiKey: string,
): Promise<ModelInfo[]> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as {
    data: Array<{ id: string; display_name?: string }>;
  };

  return data.data
    .map((m) => ({ id: m.id, name: m.display_name ?? m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
