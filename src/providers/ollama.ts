import type { ModelInfo } from "./types";

const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434";

export async function fetchOllamaModels(
  endpoint?: string,
): Promise<ModelInfo[]> {
  const base = (endpoint || DEFAULT_OLLAMA_ENDPOINT).replace(/\/+$/, "");

  const res = await fetch(`${base}/api/tags`);

  if (!res.ok) throw new Error(`Ollama API ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as {
    models: Array<{
      name: string;
      model: string;
      details?: {
        family?: string;
        parameter_size?: string;
      };
    }>;
  };

  return data.models
    .map((m) => ({
      id: m.name,
      name: m.details?.parameter_size
        ? `${m.name} (${m.details.parameter_size})`
        : m.name,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
