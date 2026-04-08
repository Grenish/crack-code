import type { ModelInfo } from "./types";

type MaybeString = string | null | undefined;

export interface NormalizeModelInput {
  id: MaybeString;
  name?: MaybeString;
}

function asNonEmptyString(value: MaybeString): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeId(value: string): string {
  return value.trim();
}

function normalizeName(id: string, name?: MaybeString): string {
  return asNonEmptyString(name) ?? id;
}

function compareModelIds(a: string, b: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  const aPreview = aLower.includes("preview");
  const bPreview = bLower.includes("preview");

  if (aPreview !== bPreview) {
    return aPreview ? 1 : -1;
  }

  return aLower.localeCompare(bLower, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function dedupeAndSortModels(models: ModelInfo[]): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();

  for (const model of models) {
    const id = asNonEmptyString(model.id);
    if (!id) continue;

    const normalizedId = normalizeId(id);
    const normalizedName = normalizeName(normalizedId, model.name);
    const existing = byId.get(normalizedId);

    if (!existing) {
      byId.set(normalizedId, { id: normalizedId, name: normalizedName });
      continue;
    }

    const existingName = asNonEmptyString(existing.name) ?? existing.id;
    const nextName =
      existingName === existing.id && normalizedName !== normalizedId
        ? normalizedName
        : existingName;

    byId.set(normalizedId, {
      id: normalizedId,
      name: nextName,
    });
  }

  return [...byId.values()].sort((a, b) => compareModelIds(a.id, b.id));
}

export function normalizeModels(inputs: NormalizeModelInput[]): ModelInfo[] {
  const models: ModelInfo[] = [];

  for (const input of inputs) {
    const id = asNonEmptyString(input.id);
    if (!id) continue;

    const normalizedId = normalizeId(id);
    models.push({
      id: normalizedId,
      name: normalizeName(normalizedId, input.name),
    });
  }

  return dedupeAndSortModels(models);
}

export function stripPrefix(
  value: MaybeString,
  prefix: string,
): string | null {
  const normalized = asNonEmptyString(value);
  if (!normalized) return null;
  return normalized.startsWith(prefix)
    ? normalized.slice(prefix.length)
    : normalized;
}

export function includesAny(
  value: MaybeString,
  needles: readonly string[],
): boolean {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized) return false;

  return needles.some((needle) => normalized.includes(needle.toLowerCase()));
}

export function startsWithAny(
  value: MaybeString,
  prefixes: readonly string[],
): boolean {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized) return false;

  return prefixes.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
}

export function isLikelyTextGenerationModel(
  id: MaybeString,
  options: {
    includePrefixes?: readonly string[];
    excludeTerms?: readonly string[];
  } = {},
): boolean {
  const normalized = asNonEmptyString(id)?.toLowerCase();
  if (!normalized) return false;

  const includePrefixes = options.includePrefixes ?? [];
  const excludeTerms = options.excludeTerms ?? [
    "embed",
    "embedding",
    "image",
    "audio",
    "speech",
    "transcrib",
    "tts",
    "whisper",
    "moderation",
    "rerank",
    "search",
    "realtime",
  ];

  if (includePrefixes.length > 0 && !startsWithAny(normalized, includePrefixes)) {
    return false;
  }

  return !includesAny(normalized, excludeTerms);
}

export function buildDisplayName(
  id: MaybeString,
  preferredName?: MaybeString,
  suffix?: MaybeString,
): string | null {
  const normalizedId = asNonEmptyString(id);
  if (!normalizedId) return null;

  const normalizedName = asNonEmptyString(preferredName);
  const normalizedSuffix = asNonEmptyString(suffix);

  if (normalizedName && normalizedSuffix) {
    return `${normalizedName} (${normalizedSuffix})`;
  }

  if (normalizedName) {
    return normalizedName;
  }

  if (normalizedSuffix) {
    return `${normalizedId} (${normalizedSuffix})`;
  }

  return normalizedId;
}
