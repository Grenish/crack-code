import { z } from "zod";
import type { Config, WebSearchProvider } from "../config.js";
import type { ToolDef } from "./registry.js";

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

const schema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Search query to run against the configured web search provider"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe("Maximum number of results (default 5, max 10)"),
  recency: z
    .string()
    .optional()
    .describe(
      "Optional recency filter. Google: d7/w2/m1/y1. Brave: pd/pw/pm/py. Tavily: day/week/month/year.",
    ),
});

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function createWebSearchTool(config: Config): ToolDef<typeof schema> {
  return {
    name: "web_search",
    description:
      "Search the web using the configured search provider (Google Custom Search, Brave Search, or Tavily). " +
      "Returns titles, URLs, and snippets.",
    inputSchema: schema,
    requiresApproval: true,

    async execute({ query, limit, recency }) {
      const provider = config.searchProvider;
      const apiKey = config.searchApiKey;
      const maxResults = Math.max(1, Math.min(MAX_LIMIT, limit ?? DEFAULT_LIMIT));

      if (!provider || !apiKey) {
        return (
          "Error: web search is not configured. " +
          "Run `crack-code --setup` and configure a search provider."
        );
      }

      if (provider === "google" && !config.searchGoogleCx) {
        return (
          "Error: Google search is selected but missing search engine ID (cx). " +
          "Run `crack-code --setup` and set the Programmable Search Engine ID."
        );
      }

      try {
        let results: SearchResult[] = [];

        switch (provider) {
          case "google":
            results = await searchWithGoogle(
              query,
              apiKey,
              config.searchGoogleCx!,
              maxResults,
              recency,
            );
            break;
          case "brave":
            results = await searchWithBrave(query, apiKey, maxResults, recency);
            break;
          case "tavily":
            results = await searchWithTavily(query, apiKey, maxResults, recency);
            break;
        }

        return formatResults(provider, query, results);
      } catch (error: any) {
        return `Error: web search failed — ${error?.message ?? String(error)}`;
      }
    },
  };
}

async function searchWithGoogle(
  query: string,
  apiKey: string,
  cx: string,
  limit: number,
  recency?: string,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    key: apiKey,
    cx,
    q: query,
    num: String(Math.min(10, limit)),
  });

  if (recency?.trim()) {
    params.set("dateRestrict", recency.trim());
  }

  const data = await requestJson<{
    items?: Array<{ title?: string; link?: string; snippet?: string }>;
  }>(`https://www.googleapis.com/customsearch/v1?${params.toString()}`);

  return (data.items ?? [])
    .map((item) => ({
      title: clean(item.title),
      url: clean(item.link),
      snippet: clean(item.snippet),
    }))
    .filter((item) => item.url.length > 0);
}

async function searchWithBrave(
  query: string,
  apiKey: string,
  limit: number,
  recency?: string,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(20, limit)),
  });

  if (recency?.trim()) {
    params.set("freshness", recency.trim());
  }

  const data = await requestJson<{
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
        extra_snippets?: string[];
      }>;
    };
  }>(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
    "X-Subscription-Token": apiKey,
  });

  return (data.web?.results ?? [])
    .map((item) => ({
      title: clean(item.title),
      url: clean(item.url),
      snippet: clean(item.description || item.extra_snippets?.[0]),
    }))
    .filter((item) => item.url.length > 0);
}

async function searchWithTavily(
  query: string,
  apiKey: string,
  limit: number,
  recency?: string,
): Promise<SearchResult[]> {
  const body: Record<string, unknown> = {
    query,
    max_results: limit,
    search_depth: "basic",
    include_answer: false,
    include_raw_content: false,
  };

  if (recency?.trim()) {
    body.time_range = recency.trim();
  }

  const data = await requestJson<{
    results?: Array<{ title?: string; url?: string; content?: string }>;
  }>("https://api.tavily.com/search", {
    Authorization: `Bearer ${apiKey}`,
  }, body);

  return (data.results ?? [])
    .map((item) => ({
      title: clean(item.title),
      url: clean(item.url),
      snippet: clean(item.content),
    }))
    .filter((item) => item.url.length > 0);
}

async function requestJson<T>(
  url: string,
  headers: Record<string, string> = {},
  body?: Record<string, unknown>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    const text = await response.text();
    const parsed = text ? safeJsonParse(text) : null;

    if (!response.ok) {
      const message =
        (parsed &&
          typeof parsed === "object" &&
          ((parsed as any).error?.message ??
            (parsed as any).message ??
            (parsed as any).detail)) ||
        text ||
        `HTTP ${response.status}`;
      throw new Error(`HTTP ${response.status}: ${message}`);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid JSON response.");
    }

    return parsed as T;
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function clean(value?: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function providerName(provider: WebSearchProvider): string {
  switch (provider) {
    case "google":
      return "Google";
    case "brave":
      return "Brave";
    case "tavily":
      return "Tavily";
  }
}

function formatResults(
  provider: WebSearchProvider,
  query: string,
  results: SearchResult[],
): string {
  if (results.length === 0) {
    return [
      `Search provider: ${providerName(provider)}`,
      `Query: ${query}`,
      "No results found.",
    ].join("\n");
  }

  const lines: string[] = [
    `Search provider: ${providerName(provider)}`,
    `Query: ${query}`,
    `Results: ${results.length}`,
    "",
  ];

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    lines.push(`${i + 1}. ${result.title || "(untitled)"}`);
    lines.push(`   URL: ${result.url}`);
    if (result.snippet) {
      lines.push(`   Snippet: ${result.snippet}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
