import type { ModelInfo } from "./types";

// Azure OpenAI uses deployment names as model identifiers.
// The apiKey here is the Azure API key, and resourceName is extracted
// from the endpoint or passed separately.

export async function fetchAzureModels(
  apiKey: string,
  resourceName: string,
): Promise<ModelInfo[]> {
  const apiVersion = "2024-10-21";
  const url = `https://${resourceName}.openai.azure.com/openai/deployments?api-version=${apiVersion}`;

  const res = await fetch(url, {
    headers: { "api-key": apiKey },
  });

  if (!res.ok) throw new Error(`Azure API ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as {
    data: Array<{
      id: string;
      model: string;
      status: string;
    }>;
  };

  return data.data
    .filter((d) => d.status === "succeeded")
    .map((d) => ({
      id: d.id,
      name: d.model !== d.id ? `${d.id} (${d.model})` : d.id,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
