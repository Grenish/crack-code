// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Findings Types & Builders
// ─────────────────────────────────────────────────────────────────────────────
// Defines the structured Finding type that every analysis pipeline produces,
// severity comparison helpers, finding builders, and the AI-prompt generator
// that creates ready-to-use remediation prompts for each finding.
//
// Findings are the core output artifact of Crack Code. The tool NEVER
// modifies source files — it only emits these structured findings that
// include severity, classification, explanation, affected files, suggested
// remediation, and a developer-facing AI prompt.
//
// Zero external dependencies.
// ─────────────────────────────────────────────────────────────────────────────

import {
  SEVERITY,
  SEVERITY_ORDER,
  SEVERITY_LABELS,
  type Severity,
  VULN_CATEGORY,
  type VulnCategory,
  APP_NAME,
} from "../utils/constants.js";

// ── Finding Interface ───────────────────────────────────────────────────────

/**
 * A specific line or range within a file where the issue was detected.
 */
export interface AffectedLocation {
  /** Relative file path from the project root */
  file: string;
  /** Starting line number (1-based), if known */
  startLine?: number;
  /** Ending line number (1-based), if known */
  endLine?: number;
  /** The actual code snippet at the affected location */
  snippet?: string;
  /** Column number (1-based), if known */
  column?: number;
}

/**
 * A single security finding produced by analysis.
 *
 * This is the canonical output type — every scanner, analyzer, and AI
 * agent finding is normalized into this shape before display or export.
 */
export interface Finding {
  /** Unique identifier for this finding (UUID-like) */
  id: string;

  /** Human-readable title / summary of the finding */
  title: string;

  /** Detailed description explaining the issue, its impact, and context */
  description: string;

  /** Severity level */
  severity: Severity;

  /** Vulnerability category */
  category: VulnCategory;

  /** Confidence level (0.0 – 1.0) — how certain the analyzer is */
  confidence: number;

  /** Affected file(s) and location(s) */
  locations: AffectedLocation[];

  /** Step-by-step remediation guidance */
  remediation: string;

  /** Ready-to-use AI prompt the developer can paste to fix the issue */
  aiPrompt: string;

  /** CWE identifier(s), if applicable (e.g. "CWE-79") */
  cweIds: string[];

  /** OWASP Top 10 category, if applicable (e.g. "A03:2021") */
  owaspCategory?: string;

  /** References — links to documentation, advisories, or standards */
  references: string[];

  /** Which analyzer or pipeline produced this finding */
  source: FindingSource;

  /** ISO 8601 timestamp of when the finding was created */
  createdAt: string;

  /** Additional metadata (analyzer-specific) */
  metadata: Record<string, unknown>;
}

/**
 * The origin of a finding — which analysis pipeline produced it.
 */
export type FindingSource =
  | "pattern-match"    // Static regex / AST pattern rules
  | "secret-detection" // Credential / secret scanning
  | "dependency-audit" // Dependency / manifest analysis
  | "ai-analysis"      // AI agent analysis
  | "manual"           // User-reported
  | "custom-tool";     // Custom tool output

// ── Finding Builder ─────────────────────────────────────────────────────────

/**
 * Input for the finding builder. All optional fields have sensible defaults.
 */
export interface FindingInput {
  title: string;
  description: string;
  severity: Severity;
  category: VulnCategory;
  locations: AffectedLocation[];
  remediation: string;
  source: FindingSource;

  /** Optional — auto-generated if omitted */
  id?: string;
  /** Optional — auto-generated if omitted */
  aiPrompt?: string;
  /** Confidence 0–1 (default 0.8) */
  confidence?: number;
  /** CWE IDs */
  cweIds?: string[];
  /** OWASP category */
  owaspCategory?: string;
  /** Reference links */
  references?: string[];
  /** Extra metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Generate a unique finding ID.
 *
 * Uses a combination of timestamp and random hex to produce a short,
 * collision-resistant identifier without requiring `crypto.randomUUID`.
 */
function generateFindingId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `fnd_${ts}_${rand}`;
}

/**
 * Build a complete Finding from partial input.
 *
 * Auto-generates `id`, `aiPrompt`, and `createdAt` if not provided.
 */
export function createFinding(input: FindingInput): Finding {
  const id = input.id ?? generateFindingId();
  const createdAt = new Date().toISOString();
  const confidence = input.confidence ?? 0.8;

  // Auto-generate AI prompt if not provided
  const aiPrompt =
    input.aiPrompt ?? generateAIPrompt(input);

  return {
    id,
    title: input.title,
    description: input.description,
    severity: input.severity,
    category: input.category,
    confidence,
    locations: input.locations,
    remediation: input.remediation,
    aiPrompt,
    cweIds: input.cweIds ?? [],
    owaspCategory: input.owaspCategory,
    references: input.references ?? [],
    source: input.source,
    createdAt,
    metadata: input.metadata ?? {},
  };
}

/**
 * Build multiple findings from an array of inputs.
 */
export function createFindings(inputs: FindingInput[]): Finding[] {
  return inputs.map(createFinding);
}

// ── AI Prompt Generator ─────────────────────────────────────────────────────

/**
 * Generate a ready-to-use AI prompt for a specific finding.
 *
 * The prompt is written so the developer can paste it into any AI assistant
 * (ChatGPT, Claude, Copilot, etc.) to get a working fix.
 */
export function generateAIPrompt(input: FindingInput): string {
  const locationDescs = input.locations
    .map((loc) => {
      let desc = loc.file;
      if (loc.startLine) {
        desc += `:${loc.startLine}`;
        if (loc.endLine && loc.endLine !== loc.startLine) {
          desc += `-${loc.endLine}`;
        }
      }
      return desc;
    })
    .join(", ");

  const cweRef =
    input.cweIds && input.cweIds.length > 0
      ? `\nRelevant CWE(s): ${input.cweIds.join(", ")}`
      : "";

  const owaspRef = input.owaspCategory
    ? `\nOWASP Top 10: ${input.owaspCategory}`
    : "";

  return [
    `Fix the following ${input.severity.toUpperCase()} security issue in my codebase:`,
    ``,
    `**Issue:** ${input.title}`,
    `**Category:** ${formatCategoryLabel(input.category)}`,
    `**File(s):** ${locationDescs}`,
    ``,
    `**Description:**`,
    input.description,
    ``,
    `**Suggested Remediation:**`,
    input.remediation,
    cweRef,
    owaspRef,
    ``,
    `Please provide the corrected code with explanations of each change.`,
    `Ensure the fix follows security best practices and does not introduce regressions.`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/**
 * Generate a consolidated AI prompt for multiple related findings.
 */
export function generateBatchAIPrompt(findings: Finding[]): string {
  if (findings.length === 0) {
    return "No findings to generate a prompt for.";
  }

  if (findings.length === 1) {
    return findings[0]!.aiPrompt;
  }

  const summaries = findings
    .map((f, i) => {
      const locs = f.locations
        .map((l) => l.file + (l.startLine ? `:${l.startLine}` : ""))
        .join(", ");
      return [
        `### ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}`,
        `   Category: ${formatCategoryLabel(f.category)}`,
        `   File(s): ${locs}`,
        `   ${f.description}`,
        `   Suggested fix: ${f.remediation}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    `Fix the following ${findings.length} security issues in my codebase:`,
    ``,
    summaries,
    ``,
    `Please provide corrected code for each issue with explanations.`,
    `Ensure all fixes follow security best practices and do not introduce regressions.`,
  ].join("\n");
}

// ── Severity Helpers ────────────────────────────────────────────────────────

/**
 * Compare two severity levels.
 * Returns negative if `a` is MORE severe, positive if `b` is more severe,
 * zero if equal.
 *
 * This follows the convention of Array.sort comparators — sort ascending
 * by severity means most severe first.
 */
export function compareSeverity(a: Severity, b: Severity): number {
  const indexA = SEVERITY_ORDER.indexOf(a);
  const indexB = SEVERITY_ORDER.indexOf(b);
  return indexA - indexB;
}

/**
 * Sort findings by severity (most severe first), then by confidence
 * (highest first), then alphabetically by title.
 */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    // Severity: most severe first
    const sevCmp = compareSeverity(a.severity, b.severity);
    if (sevCmp !== 0) return sevCmp;

    // Confidence: highest first
    if (a.confidence !== b.confidence) {
      return b.confidence - a.confidence;
    }

    // Title: alphabetical
    return a.title.localeCompare(b.title);
  });
}

/**
 * Check if a severity level meets or exceeds a minimum threshold.
 *
 * Example: `severityMeetsThreshold("high", "medium")` → true
 *          (high is more severe than medium)
 */
export function severityMeetsThreshold(
  severity: Severity,
  threshold: Severity
): boolean {
  const severityIdx = SEVERITY_ORDER.indexOf(severity);
  const thresholdIdx = SEVERITY_ORDER.indexOf(threshold);
  return severityIdx <= thresholdIdx;
}

/**
 * Get the human-readable label for a severity level.
 */
export function getSeverityLabel(severity: Severity): string {
  return SEVERITY_LABELS[severity] ?? severity.toUpperCase();
}

/**
 * Determine the highest (most critical) severity among a list of findings.
 */
export function highestSeverity(findings: Finding[]): Severity | null {
  if (findings.length === 0) return null;

  let highest: Severity = SEVERITY.INFO;
  for (const f of findings) {
    if (compareSeverity(f.severity, highest) < 0) {
      highest = f.severity;
    }
  }
  return highest;
}

// ── Category Helpers ────────────────────────────────────────────────────────

/**
 * Format a VulnCategory constant into a human-readable label.
 *
 * Example: "cross-site-scripting" → "Cross-Site Scripting"
 */
export function formatCategoryLabel(category: VulnCategory): string {
  return category
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Get all unique categories present in a set of findings.
 */
export function getUniqueCategories(findings: Finding[]): VulnCategory[] {
  const seen = new Set<VulnCategory>();
  for (const f of findings) {
    seen.add(f.category);
  }
  return Array.from(seen);
}

// ── Filtering ───────────────────────────────────────────────────────────────

/**
 * Filter findings by minimum severity threshold.
 */
export function filterBySeverity(
  findings: Finding[],
  minSeverity: Severity
): Finding[] {
  return findings.filter((f) => severityMeetsThreshold(f.severity, minSeverity));
}

/**
 * Filter findings by category.
 */
export function filterByCategory(
  findings: Finding[],
  categories: VulnCategory[]
): Finding[] {
  const catSet = new Set<string>(categories);
  return findings.filter((f) => catSet.has(f.category));
}

/**
 * Filter findings by file path (substring match).
 */
export function filterByFile(
  findings: Finding[],
  filePath: string
): Finding[] {
  const lower = filePath.toLowerCase();
  return findings.filter((f) =>
    f.locations.some((loc) => loc.file.toLowerCase().includes(lower))
  );
}

/**
 * Filter findings by source.
 */
export function filterBySource(
  findings: Finding[],
  source: FindingSource
): Finding[] {
  return findings.filter((f) => f.source === source);
}

/**
 * Filter findings by minimum confidence.
 */
export function filterByConfidence(
  findings: Finding[],
  minConfidence: number
): Finding[] {
  return findings.filter((f) => f.confidence >= minConfidence);
}

// ── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Count findings grouped by severity.
 */
export function countBySeverity(
  findings: Finding[]
): Record<Severity, number> {
  const counts: Record<string, number> = {
    [SEVERITY.CRITICAL]: 0,
    [SEVERITY.HIGH]: 0,
    [SEVERITY.MEDIUM]: 0,
    [SEVERITY.LOW]: 0,
    [SEVERITY.INFO]: 0,
  };

  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }

  return counts as Record<Severity, number>;
}

/**
 * Count findings grouped by category.
 */
export function countByCategory(
  findings: Finding[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.category] = (counts[f.category] ?? 0) + 1;
  }
  return counts;
}

/**
 * Count findings grouped by source.
 */
export function countBySource(
  findings: Finding[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.source] = (counts[f.source] ?? 0) + 1;
  }
  return counts;
}

/**
 * Get all unique files affected across all findings.
 */
export function getAffectedFiles(findings: Finding[]): string[] {
  const files = new Set<string>();
  for (const f of findings) {
    for (const loc of f.locations) {
      files.add(loc.file);
    }
  }
  return Array.from(files).sort();
}

// ── Summary ─────────────────────────────────────────────────────────────────

/**
 * A high-level summary of a set of findings.
 */
export interface FindingsSummary {
  /** Total number of findings */
  totalFindings: number;
  /** Counts by severity */
  bySeverity: Record<Severity, number>;
  /** Counts by category */
  byCategory: Record<string, number>;
  /** Counts by source */
  bySource: Record<string, number>;
  /** All affected files (deduplicated) */
  affectedFiles: string[];
  /** Number of affected files */
  affectedFileCount: number;
  /** The highest severity encountered */
  highestSeverity: Severity | null;
  /** Unique categories found */
  categories: VulnCategory[];
  /** Average confidence */
  averageConfidence: number;
}

/**
 * Build a summary from a collection of findings.
 */
export function summarizeFindings(findings: Finding[]): FindingsSummary {
  const bySeverity = countBySeverity(findings);
  const byCategory = countByCategory(findings);
  const bySource = countBySource(findings);
  const affectedFiles = getAffectedFiles(findings);
  const categories = getUniqueCategories(findings);
  const highest = highestSeverity(findings);

  const avgConfidence =
    findings.length > 0
      ? findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length
      : 0;

  return {
    totalFindings: findings.length,
    bySeverity,
    byCategory,
    bySource,
    affectedFiles,
    affectedFileCount: affectedFiles.length,
    highestSeverity: highest,
    categories,
    averageConfidence: Math.round(avgConfidence * 1000) / 1000,
  };
}

// ── Deduplication ───────────────────────────────────────────────────────────

/**
 * Deduplicate findings based on title + file + start line.
 *
 * When duplicates are found, keeps the one with the highest severity.
 * If severity is equal, keeps the one with the highest confidence.
 */
export function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();

  for (const finding of findings) {
    const key = buildDedupeKey(finding);
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, finding);
      continue;
    }

    // Keep the more severe / higher confidence one
    const sevCmp = compareSeverity(finding.severity, existing.severity);
    if (sevCmp < 0 || (sevCmp === 0 && finding.confidence > existing.confidence)) {
      seen.set(key, finding);
    }
  }

  return Array.from(seen.values());
}

/**
 * Build a deduplication key for a finding.
 */
function buildDedupeKey(finding: Finding): string {
  const primaryLoc = finding.locations[0];
  const file = primaryLoc?.file ?? "unknown";
  const line = primaryLoc?.startLine ?? 0;

  // Normalize title to ignore case/whitespace differences
  const normalizedTitle = finding.title.toLowerCase().trim().replace(/\s+/g, " ");

  return `${normalizedTitle}::${file}::${line}`;
}

// ── Serialization ───────────────────────────────────────────────────────────

/**
 * Serialize findings to a plain JSON-safe object.
 * (Findings are already plain objects, but this ensures type safety.)
 */
export function serializeFindings(findings: Finding[]): unknown[] {
  return findings.map((f) => ({ ...f }));
}

/**
 * Deserialize findings from a parsed JSON array.
 * Performs basic shape validation.
 */
export function deserializeFindings(data: unknown): Finding[] {
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object"
    )
    .filter(
      (item) =>
        typeof item["id"] === "string" &&
        typeof item["title"] === "string" &&
        typeof item["severity"] === "string" &&
        typeof item["category"] === "string"
    )
    .map((item) => ({
      id: item["id"] as string,
      title: item["title"] as string,
      description: (item["description"] as string) ?? "",
      severity: item["severity"] as Severity,
      category: item["category"] as VulnCategory,
      confidence: typeof item["confidence"] === "number" ? (item["confidence"] as number) : 0.5,
      locations: Array.isArray(item["locations"])
        ? (item["locations"] as AffectedLocation[])
        : [],
      remediation: (item["remediation"] as string) ?? "",
      aiPrompt: (item["aiPrompt"] as string) ?? "",
      cweIds: Array.isArray(item["cweIds"]) ? (item["cweIds"] as string[]) : [],
      owaspCategory: item["owaspCategory"] as string | undefined,
      references: Array.isArray(item["references"])
        ? (item["references"] as string[])
        : [],
      source: (item["source"] as FindingSource) ?? "manual",
      createdAt: (item["createdAt"] as string) ?? new Date().toISOString(),
      metadata:
        typeof item["metadata"] === "object" && item["metadata"] !== null
          ? (item["metadata"] as Record<string, unknown>)
          : {},
    }));
}

// ── Merge ───────────────────────────────────────────────────────────────────

/**
 * Merge findings from multiple sources, deduplicating and sorting.
 */
export function mergeFindings(...findingArrays: Finding[][]): Finding[] {
  const all = findingArrays.flat();
  const deduped = deduplicateFindings(all);
  return sortFindings(deduped);
}
