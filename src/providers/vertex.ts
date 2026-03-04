import type { ModelInfo } from "./types";
import crypto from "node:crypto";

// Vertex AI authenticates via a Google Cloud service account.
// We use the client_email and private_key from the service account JSON
// to mint a short-lived access token, then validate credentials with a
// lightweight API call.
//
// There is no public "list all publisher models" REST endpoint on Vertex AI,
// so we return a curated list of well-known Gemini models and verify the
// credentials work by pinging a single model endpoint.

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

// Curated list of Gemini models available on Vertex AI.
// Kept in rough order of capability (newest/largest first).
const KNOWN_VERTEX_MODELS: ModelInfo[] = [
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  {
    id: "gemini-2.5-flash-lite-preview-06-17",
    name: "Gemini 2.5 Flash Lite (Preview)",
  },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
  { id: "gemini-2.0-flash-lite", name: "Gemini 2.0 Flash Lite" },
  { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro" },
  { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash" },
];

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

/**
 * Validate that the service account credentials can reach the Vertex AI API
 * by pinging a single known model's GET endpoint.
 * Returns true if the credentials + project + location are valid.
 */
async function validateCredentials(
  accessToken: string,
  project: string,
  location: string,
): Promise<boolean> {
  // Use the publishers.models.get endpoint with a known model
  const url = `https://${location}-aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.0-flash`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-goog-user-project": project,
    },
  });

  return res.ok;
}

export async function fetchVertexModels(
  project: string,
  location: string = "us-central1",
  clientEmail?: string,
  privateKey?: string,
): Promise<ModelInfo[]> {
  if (!clientEmail || !privateKey) {
    // No service account credentials — can't authenticate
    throw new Error(
      "Vertex AI requires service account credentials. Run: crack-code --setup",
    );
  }

  // Get an access token from the service account
  const accessToken = await getAccessToken(clientEmail, privateKey);

  // Validate that credentials actually work against the Vertex API
  const valid = await validateCredentials(accessToken, project, location);

  if (!valid) {
    throw new Error(
      "Vertex AI credentials validation failed. " +
        "Ensure the service account has the 'Vertex AI User' role " +
        "and the project/location are correct.",
    );
  }

  // Return the curated list — the credentials are confirmed working
  return KNOWN_VERTEX_MODELS;
}
