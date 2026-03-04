import type { ModelInfo } from "./types";

export async function fetchOpenAIModels(apiKey: string): Promise<ModelInfo[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as { data: Array<{ id: string }> };

  // Filter to chat models only — skip embeddings, tts, dall-e, whisper, etc.
  const chatPrefixes = ["gpt-", "o1", "o3", "o4", "chatgpt-"];
  const exclude = ["instruct", "realtime", "audio", "search"];

  return data.data
    .filter((m) => {
      const id = m.id.toLowerCase();
      const hasPrefix = chatPrefixes.some((p) => id.startsWith(p));
      const isExcluded = exclude.some((e) => id.includes(e));
      return hasPrefix && !isExcluded;
    })
    .map((m) => ({ id: m.id, name: m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
