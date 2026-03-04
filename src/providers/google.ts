import type { ModelInfo } from "./types";

export async function fetchGoogleModels(apiKey: string): Promise<ModelInfo[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
  );

  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as {
    models: Array<{
      name: string;
      displayName: string;
      supportedGenerationMethods?: string[];
    }>;
  };

  return data.models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => ({
      // API returns "models/gemini-2.5-flash" → extract "gemini-2.5-flash"
      id: m.name.replace("models/", ""),
      name: m.displayName,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
