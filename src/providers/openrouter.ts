import type { ModelInfo } from "./types";

export async function fetchOpenRouterModels(
  apiKey: string,
): Promise<ModelInfo[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as {
    data: Array<{ id: string; name?: string }>;
  };

  // Filter to chat/completion models and exclude image/audio-only models
  const exclude = ["image", "vision-only", "audio-only", "embedding"];

  return data.data
    .filter((m) => {
      const id = m.id.toLowerCase();
      return !exclude.some((e) => id.includes(e));
    })
    .map((m) => ({ id: m.id, name: m.name ?? m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
