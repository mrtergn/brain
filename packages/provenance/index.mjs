import path from 'node:path';

import { clamp, normalizeSlashes, sha256, truncate, uniqueStrings } from '../shared/index.mjs';

export const EVIDENCE_MODEL_VERSION = 'provenance-v1';

const EVIDENCE_QUALITY_SCORES = {
  weak: 1,
  medium: 2,
  strong: 3,
};

const DERIVED_FROM_BASE_CONFIDENCE = {
  'readme-excerpt': 0.92,
  'explicit-doc': 0.88,
  'manual-note': 0.86,
  'manifest-script': 0.84,
  'note-structure': 0.82,
  'doc-structure': 0.8,
  'cross-project-aggregation': 0.79,
  'directory-layout': 0.72,
  'package-manifest': 0.72,
  'filesystem-layout': 0.7,
  'heuristic-inference': 0.56,
  'heuristic-fallback': 0.34,
};

export function createEvidenceSource({
  sourcePath,
  sourceKind,
  sourceSection = null,
  excerpt = '',
} = {}) {
  const normalizedPath = normalizeSourcePath(sourcePath);
  const resolvedKind = sourceKind ?? inferSourceKind(normalizedPath);
  return {
    sourcePath: normalizedPath,
    sourceKind: resolvedKind,
    sourceSection: normalizeOptionalText(sourceSection),
    excerpt: truncate(normalizeOptionalText(excerpt), 220),
  };
}

export function createEvidenceItem({
  category,
  value,
  sources = [],
  derivedFrom = 'heuristic-inference',
  confidence,
  evidenceQuality,
} = {}) {
  const normalizedValue = normalizeOptionalText(value);
  if (!normalizedValue) {
    return null;
  }

  const normalizedSources = dedupeEvidenceSources(sources).slice(0, 4);
  const resolvedQuality = evidenceQuality ?? inferEvidenceQuality({
    sources: normalizedSources,
    derivedFrom,
  });
  const resolvedConfidence = Number((confidence ?? inferConfidence({
    sources: normalizedSources,
    derivedFrom,
    evidenceQuality: resolvedQuality,
  })).toFixed(4));

  return {
    id: sha256(`${category ?? 'unknown'}:${normalizedValue}:${JSON.stringify(normalizedSources)}`),
    category: normalizeOptionalText(category),
    value: normalizedValue,
    confidence: resolvedConfidence,
    evidenceQuality: resolvedQuality,
    derivedFrom,
    supportCount: normalizedSources.length,
    sources: normalizedSources,
  };
}

export function mergeEvidenceItems(items = []) {
  const grouped = new Map();
  for (const item of items.filter(Boolean)) {
    const key = `${item.category ?? 'unknown'}:${item.value}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        ...item,
        sources: dedupeEvidenceSources(item.sources ?? []),
      });
      continue;
    }

    const mergedSources = dedupeEvidenceSources([
      ...(existing.sources ?? []),
      ...(item.sources ?? []),
    ]).slice(0, 4);
    const bestQuality = compareEvidenceQuality(existing.evidenceQuality, item.evidenceQuality) >= 0
      ? existing.evidenceQuality
      : item.evidenceQuality;
    const bestConfidence = Math.max(Number(existing.confidence ?? 0), Number(item.confidence ?? 0));

    grouped.set(key, {
      ...existing,
      confidence: Number(bestConfidence.toFixed(4)),
      evidenceQuality: bestQuality,
      derivedFrom: existing.derivedFrom === item.derivedFrom
        ? existing.derivedFrom
        : uniqueStrings([existing.derivedFrom, item.derivedFrom]).join(' | '),
      supportCount: mergedSources.length,
      sources: mergedSources,
    });
  }

  return sortEvidenceItems([...grouped.values()]);
}

export function sortEvidenceItems(items = []) {
  return [...items].sort((left, right) => {
    const qualityDelta = compareEvidenceQuality(right?.evidenceQuality, left?.evidenceQuality);
    if (qualityDelta !== 0) {
      return qualityDelta;
    }
    const confidenceDelta = Number(right?.confidence ?? 0) - Number(left?.confidence ?? 0);
    if (confidenceDelta !== 0) {
      return confidenceDelta;
    }
    const supportDelta = Number(right?.supportCount ?? 0) - Number(left?.supportCount ?? 0);
    if (supportDelta !== 0) {
      return supportDelta;
    }
    return String(left?.value ?? '').localeCompare(String(right?.value ?? ''));
  });
}

export function evidenceItemsToValues(items = []) {
  return items.filter(Boolean).map((item) => item.value);
}

export function flattenProvenanceRecords(provenance = {}) {
  const flattened = [];
  for (const [category, value] of Object.entries(provenance ?? {})) {
    if (!value) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item) {
          flattened.push(item.category ? item : { ...item, category });
        }
      }
      continue;
    }
    flattened.push(value.category ? value : { ...value, category });
  }
  return sortEvidenceItems(flattened);
}

export function summarizeEvidenceSource(source, { includeExcerpt = false } = {}) {
  if (!source) {
    return '';
  }
  const location = [source.sourcePath, source.sourceSection].filter(Boolean).join(' > ');
  if (!includeExcerpt || !source.excerpt) {
    return location;
  }
  return `${location} :: ${truncate(source.excerpt, 120)}`;
}

export function summarizeEvidenceItem(item, { includeExcerpt = false } = {}) {
  if (!item) {
    return '';
  }
  const support = (item.sources ?? []).slice(0, 2).map((source) => summarizeEvidenceSource(source, { includeExcerpt })).filter(Boolean).join(' | ');
  return `${item.value} [${item.evidenceQuality} ${item.confidence}]${support ? ` ${support}` : ''}`;
}

export function pickTopEvidenceItems(items = [], limit = 3) {
  return sortEvidenceItems(items).slice(0, limit);
}

export function maxEvidenceQuality(items = []) {
  const sorted = sortEvidenceItems(items);
  return sorted[0]?.evidenceQuality ?? 'weak';
}

export function maxEvidenceConfidence(items = []) {
  const sorted = sortEvidenceItems(items);
  return Number(sorted[0]?.confidence ?? 0);
}

export function compareEvidenceQuality(left, right) {
  return (EVIDENCE_QUALITY_SCORES[left] ?? 0) - (EVIDENCE_QUALITY_SCORES[right] ?? 0);
}

export function parseStructuredMetadata(value, fallbackValue = []) {
  if (!value || typeof value !== 'string') {
    return fallbackValue;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallbackValue;
  }
}

function dedupeEvidenceSources(sources = []) {
  const keyed = new Map();
  for (const rawSource of sources.filter(Boolean)) {
    const source = createEvidenceSource(rawSource);
    const key = `${source.sourcePath}:${source.sourceKind}:${source.sourceSection ?? ''}:${source.excerpt ?? ''}`;
    if (!keyed.has(key)) {
      keyed.set(key, source);
    }
  }
  return [...keyed.values()];
}

function inferEvidenceQuality({ sources = [], derivedFrom } = {}) {
  if (sources.length >= 2 && sources.some((source) => /readme|doc|note/.test(source.sourceKind))) {
    return 'strong';
  }
  if (['readme-excerpt', 'explicit-doc', 'manual-note', 'note-structure'].includes(derivedFrom)) {
    return 'strong';
  }
  if (['manifest-script', 'doc-structure', 'cross-project-aggregation', 'directory-layout', 'package-manifest', 'filesystem-layout'].includes(derivedFrom)) {
    return 'medium';
  }
  return 'weak';
}

function inferConfidence({ sources = [], derivedFrom, evidenceQuality } = {}) {
  const qualityFloor = evidenceQuality === 'strong'
    ? 0.82
    : (evidenceQuality === 'medium' ? 0.68 : 0.44);
  const derivedBase = DERIVED_FROM_BASE_CONFIDENCE[derivedFrom] ?? 0.56;
  const supportBonus = Math.min(sources.length * 0.03, 0.09);
  return clamp(Math.max(qualityFloor, derivedBase) + supportBonus, 0, 0.99);
}

function inferSourceKind(sourcePath) {
  const normalizedPath = normalizeSourcePath(sourcePath);
  const lower = normalizedPath.toLowerCase();
  if (!normalizedPath) {
    return 'unknown';
  }
  if (/readme(?:\.[a-z0-9]+)?$/i.test(lower)) {
    return 'readme';
  }
  if (/(agents|claude)\.md$/i.test(lower) || /copilot-instructions\.md$/i.test(lower)) {
    return 'agent-guidance';
  }
  if (/package\.json$|pyproject\.toml$|requirements(?:-dev)?\.txt$|cargo\.toml$|go\.mod$|pom\.xml$|build\.gradle(?:\.kts)?$|pubspec\.yaml$/i.test(lower)) {
    return 'manifest';
  }
  if (/\.md$|\.mdx$|\.rst$|\.txt$/i.test(lower)) {
    return 'doc';
  }
  if (!path.basename(normalizedPath).includes('.')) {
    return 'directory';
  }
  return 'code';
}

function normalizeSourcePath(value) {
  return normalizeOptionalText(value ? normalizeSlashes(value) : '');
}

function normalizeOptionalText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}