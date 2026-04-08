import type { ModelInfo } from "./types";
import crypto from "node:crypto";

// Vertex AI authenticates via a Google Cloud service account.
// We use the client_email and private_key from the service account JSON
// to mint a short-lived access token, then list live Gemini publisher models
// from Model Garden.

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_LOCATION = "us-central1";
const PUBLISHER = "google";
const MODEL_LIST_PAGE_SIZE = 1000;
const GENERATION_MODEL_PREFIXES = ["gemini-"] as const;
const EXCLUDED_MODEL_TERMS = [
  "embedding",
  "image",
  "audio",
  "speech",
  "transcrib",
  "tts",
  "veo",
  "imagen",
  "chirp",
] as const;

/**
 * Base64url-encode a buffer or string (no padding).
 */
function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/**
 * Create a signed JWT using RS256 with Node.js built-in crypto.
 */
function createSignedJwt(clientEmail: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));

  const payload = base64url(
    JSON.stringify({
      iss: clientEmail,
      sub: clientEmail,
      aud: TOKEN_URI,
      scope: SCOPE,
      iat: now,
      exp: now + 3600,
    }),
  );

  const signingInput = `${header}.${payload}`;

  const signature = crypto
    .createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKey);

  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Exchange a service account's client_email + private_key for a
 * short-lived OAuth2 access token via the JWT-bearer grant.
 */
async function getAccessToken(
  clientEmail: string,
  privateKey: string,
): Promise<string> {
  const jwt = createSignedJwt(clientEmail, privateKey);

  const res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Failed to obtain access token: ${res.status} ${await res.text()}`,
    );
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

function normalizeModelId(name: string): string {
  const markers = [`publishers/${PUBLISHER}/models/`, "models/"];

  for (const marker of markers) {
    if (name.startsWith(marker)) {
      return name.slice(marker.length);
    }
  }

  return name;
}

function isSupportedGenerationModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();

  return (
    GENERATION_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix)) &&
    !EXCLUDED_MODEL_TERMS.some((term) => normalized.includes(term))
  );
}

function toDisplayName(modelId: string): string {
  return modelId
    .split("-")
    .map((part) => {
      if (/^\d+(\.\d+)?$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

async function fetchPublisherModelsPage(
  accessToken: string,
  project: string,
  location: string,
  pageToken?: string,
): Promise<{
  publisherModels: Array<{
    name?: string;
    versionId?: string;
  }>;
  nextPageToken?: string;
}> {
  const params = new URLSearchParams({
    pageSize: String(MODEL_LIST_PAGE_SIZE),
    listAllVersions: "true",
  });

  if (pageToken) {
    params.set("pageToken", pageToken);
  }

  const url = `https://${location}-aiplatform.googleapis.com/v1beta1/publishers/${PUBLISHER}/models?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-goog-user-project": project,
    },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to list Vertex publisher models: ${res.status} ${await res.text()}`,
    );
  }

  return (await res.json()) as {
    publisherModels: Array<{
      name?: string;
      versionId?: string;
    }>;
    nextPageToken?: string;
  };
}

async function fetchVertexPublisherModels(
  accessToken: string,
  project: string,
  location: string,
): Promise<ModelInfo[]> {
  const models = new Map<string, ModelInfo>();
  let pageToken: string | undefined;

  do {
    const page = await fetchPublisherModelsPage(
      accessToken,
      project,
      location,
      pageToken,
    );

    for (const model of page.publisherModels ?? []) {
      if (!model.name) continue;

      const id = normalizeModelId(model.name);
      if (!isSupportedGenerationModel(id)) continue;

      const existing = models.get(id);
      const displayName = toDisplayName(id);

      if (!existing) {
        models.set(id, {
          id,
          name: displayName,
        });
      }
    }

    pageToken = page.nextPageToken;
  } while (pageToken);

  return [...models.values()].sort((a, b) =>
    a.id.localeCompare(b.id, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

export async function fetchVertexModels(
  project: string,
  location: string = DEFAULT_LOCATION,
  clientEmail?: string,
  privateKey?: string,
): Promise<ModelInfo[]> {
  if (!clientEmail || !privateKey) {
    throw new Error(
      "Vertex AI requires service account credentials. Run: crack-code --setup",
    );
  }

  const accessToken = await getAccessToken(clientEmail, privateKey);
  const models = await fetchVertexPublisherModels(
    accessToken,
    project,
    location,
  );

  if (models.length === 0) {
    throw new Error(
      "No supported Vertex AI Gemini models were found. " +
        "Ensure the project/location are correct and the service account has access.",
    );
  }

  return models;
}
