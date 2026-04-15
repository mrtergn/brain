import path from 'node:path';

import {
  ensureDir,
  readJson,
  sha256,
  timestamp,
  tokenize,
  uniqueStrings,
  writeJson,
} from '../shared/index.mjs';
import { isCanonicalKnowledgeBasePath } from '../vault-contract/index.mjs';

const STATE_VERSION = 3;
const MAX_QUERY_HISTORY = 100;
const MAX_OPERATIONS = 120;
const MAX_FAILURES = 120;
const MAX_USAGE_EVENTS = 180;
const MAX_TRACKED_RESULTS = 240;
const MAX_CANDIDATES = 48;
const MAX_DISTINCT_QUERY_FINGERPRINTS = 12;
const PROMOTION_MIN_USE_COUNT = 3;
const PROMOTION_MIN_DISTINCT_QUERIES = 2;
const PROMOTION_MIN_AVERAGE_RELEVANCE = 0.55;

export function createEmptyState(config) {
  return {
    version: STATE_VERSION,
    config: {
      projectsRoot: config.projectsRoot,
      vaultRoot: config.vaultRoot,
      collectionName: config.collectionName,
      watchMode: config.watchMode,
      pollIntervalMs: config.pollIntervalMs,
    },
    projects: {},
    queryHistory: [],
    operations: [],
    failures: [],
    memoryAdmission: createEmptyMemoryAdmissionState(),
    lastScanAt: null,
    lastSyncAt: null,
    lastEmbedAt: null,
    lastLearnAt: null,
  };
}

export async function ensureBrainLayout(config) {
  await Promise.all([
    ensureDir(config.dataRoot),
    ensureDir(config.cacheRoot),
    ensureDir(config.projectCacheRoot),
    ensureDir(config.chunkCacheRoot),
    ensureDir(config.stateRoot),
    ensureDir(config.logRoot),
    ensureDir(config.chromaRoot),
    ensureDir(config.runtimeRoot),
  ]);
}

export async function loadState(config) {
  await ensureBrainLayout(config);
  const rawState = await readJson(config.statePath, createEmptyState(config));
  return normalizeState(config, rawState);
}

export async function saveState(config, state) {
  await ensureBrainLayout(config);
  await writeJson(config.statePath, normalizeState(config, state));
}

export function normalizeState(config, state) {
  const baseState = state && typeof state === 'object' ? state : createEmptyState(config);
  return {
    version: STATE_VERSION,
    config: {
      projectsRoot: config.projectsRoot,
      vaultRoot: config.vaultRoot,
      collectionName: config.collectionName,
      watchMode: config.watchMode,
      pollIntervalMs: config.pollIntervalMs,
    },
    projects: baseState.projects ?? {},
    queryHistory: normalizeQueryHistory(baseState.queryHistory ?? []),
    operations: baseState.operations ?? [],
    failures: baseState.failures ?? [],
    memoryAdmission: normalizeMemoryAdmission(baseState.memoryAdmission ?? {}),
    lastScanAt: baseState.lastScanAt ?? null,
    lastSyncAt: baseState.lastSyncAt ?? null,
    lastEmbedAt: baseState.lastEmbedAt ?? null,
    lastLearnAt: baseState.lastLearnAt ?? null,
  };
}

function createEmptyMemoryAdmissionState() {
  return {
    usageEvents: [],
    trackedResults: {},
    candidates: [],
    suppressionCounts: {
      canonicalSurface: 0,
      duplicateCandidate: 0,
    },
  };
}

function normalizeQueryHistory(entries) {
  return (entries ?? []).map((entry) => ({
    ...entry,
    topResultIds: (entry.topResultIds ?? []).filter((value) => isCanonicalTopResultId(value)),
  }));
}

function normalizeMemoryAdmission(memoryAdmission) {
  const base = memoryAdmission && typeof memoryAdmission === 'object'
    ? memoryAdmission
    : createEmptyMemoryAdmissionState();

  const usageEvents = (base.usageEvents ?? [])
    .map((event) => ({
      at: event.at ?? null,
      source: event.source === 'consult' ? 'consult' : 'query',
      mode: String(event.mode ?? 'local-only'),
      currentProjectName: event.currentProjectName ?? null,
      queryFingerprint: String(event.queryFingerprint ?? ''),
      query: String(event.query ?? ''),
      topResultKeys: uniqueStrings(event.topResultKeys ?? []),
      resultCount: Number(event.resultCount ?? 0),
      localConfidence: event.localConfidence == null ? null : Number(event.localConfidence),
      webResearchRecommended: event.webResearchRecommended == null ? null : Boolean(event.webResearchRecommended),
    }))
    .filter((event) => event.queryFingerprint)
    .slice(0, MAX_USAGE_EVENTS);

  const trackedResults = Object.fromEntries(Object.entries(base.trackedResults ?? {})
    .map(([key, value]) => [key, normalizeTrackedResult(key, value)])
    .filter(([, value]) => value));

  const candidates = (base.candidates ?? [])
    .map((candidate) => normalizeCandidate(candidate))
    .filter(Boolean)
    .sort(compareAdmissionCandidates)
    .slice(0, MAX_CANDIDATES);

  return {
    usageEvents,
    trackedResults,
    candidates,
    suppressionCounts: {
      canonicalSurface: Number(base.suppressionCounts?.canonicalSurface ?? 0),
      duplicateCandidate: Number(base.suppressionCounts?.duplicateCandidate ?? 0),
    },
  };
}

function normalizeTrackedResult(key, value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return {
    resultKey: key,
    project: String(value.project ?? 'unknown'),
    noteType: String(value.noteType ?? 'unknown'),
    sourcePath: String(value.sourcePath ?? 'unknown'),
    sourceKind: String(value.sourceKind ?? 'unknown'),
    snippet: String(value.snippet ?? '').slice(0, 220),
    firstSeenAt: value.firstSeenAt ?? null,
    lastSeenAt: value.lastSeenAt ?? null,
    useCount: Number(value.useCount ?? 0),
    queryUseCount: Number(value.queryUseCount ?? 0),
    consultUseCount: Number(value.consultUseCount ?? 0),
    topRankCount: Number(value.topRankCount ?? 0),
    sameProjectUseCount: Number(value.sameProjectUseCount ?? 0),
    strongEvidenceUseCount: Number(value.strongEvidenceUseCount ?? 0),
    averageRelevanceScore: Number(value.averageRelevanceScore ?? 0),
    evidenceQuality: String(value.evidenceQuality ?? 'weak'),
    confidence: Number(value.confidence ?? 0),
    supportCount: Number(value.supportCount ?? 0),
    distinctQueryFingerprints: uniqueStrings(value.distinctQueryFingerprints ?? []).slice(0, MAX_DISTINCT_QUERY_FINGERPRINTS),
    canonicalSuppressionRecorded: Boolean(value.canonicalSuppressionRecorded),
  };
}

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || !candidate.id || !candidate.resultKey) {
    return null;
  }
  return {
    id: String(candidate.id),
    resultKey: String(candidate.resultKey),
    project: String(candidate.project ?? 'unknown'),
    noteType: String(candidate.noteType ?? 'unknown'),
    sourcePath: String(candidate.sourcePath ?? 'unknown'),
    sourceKind: String(candidate.sourceKind ?? 'unknown'),
    summary: String(candidate.summary ?? '').slice(0, 220),
    firstQualifiedAt: candidate.firstQualifiedAt ?? null,
    lastSeenAt: candidate.lastSeenAt ?? null,
    useCount: Number(candidate.useCount ?? 0),
    distinctQueryCount: Number(candidate.distinctQueryCount ?? 0),
    queryUseCount: Number(candidate.queryUseCount ?? 0),
    consultUseCount: Number(candidate.consultUseCount ?? 0),
    topRankCount: Number(candidate.topRankCount ?? 0),
    averageRelevanceScore: Number(candidate.averageRelevanceScore ?? 0),
    evidenceQuality: String(candidate.evidenceQuality ?? 'weak'),
    confidence: Number(candidate.confidence ?? 0),
    supportCount: Number(candidate.supportCount ?? 0),
    score: Number(candidate.score ?? 0),
    targetType: candidate.targetType === 'reusable-pattern' ? 'reusable-pattern' : 'project-learning',
    targetProjectName: candidate.targetProjectName ? String(candidate.targetProjectName) : null,
  };
}

function isCanonicalTopResultId(value) {
  const candidate = String(value ?? '');
  if (!candidate) {
    return false;
  }
  if (/:logs:/i.test(candidate)) {
    return false;
  }
  if (/:knowledge:/i.test(candidate) && !isCanonicalKnowledgeBasePath(candidate)) {
    return false;
  }
  if (candidate.includes('04_Knowledge_Base/') && !isCanonicalKnowledgeBasePath(candidate)) {
    return false;
  }
  return true;
}

export function getProjectState(state, projectName) {
  return state.projects[projectName] ?? null;
}

export function setProjectState(state, projectName, patch) {
  state.projects[projectName] = {
    ...(state.projects[projectName] ?? {}),
    ...patch,
  };
}

export function recordOperation(state, type, details = {}) {
  state.operations = [
    {
      at: timestamp(),
      type,
      ...details,
    },
    ...(state.operations ?? []),
  ].slice(0, MAX_OPERATIONS);
}

export function recordFailure(state, details) {
  state.failures = [
    {
      at: timestamp(),
      ...details,
    },
    ...(state.failures ?? []),
  ].slice(0, MAX_FAILURES);
}

export function recordQuery(state, queryRecord) {
  state.queryHistory = [queryRecord, ...(state.queryHistory ?? [])].slice(0, MAX_QUERY_HISTORY);
}

export function getLatestOperation(state, operationTypes = []) {
  const allowedTypes = new Set((operationTypes ?? []).filter(Boolean));
  if (allowedTypes.size === 0) {
    return null;
  }
  return (state.operations ?? []).find((operation) => allowedTypes.has(operation.type)) ?? null;
}

export function getLastLearningActivityAt(state) {
  const latestOperation = getLatestOperation(state, ['learn', 'capture-learning']);
  const latestOperationAt = latestOperation?.at ?? null;
  if (!latestOperationAt) {
    return state.lastLearnAt ?? null;
  }
  if (!state.lastLearnAt) {
    return latestOperationAt;
  }
  return String(latestOperationAt) > String(state.lastLearnAt) ? latestOperationAt : state.lastLearnAt;
}

export function previewMemoryAdmission(state, usage, { config } = {}) {
  state.memoryAdmission = normalizeMemoryAdmission(state.memoryAdmission ?? {});
  return buildMemoryAdmissionPayload(state, {
    config,
    queryFingerprint: buildQueryFingerprint(usage?.query, usage?.currentProjectName),
    touchedResultKeys: buildTouchedResultKeys(usage?.results),
    recorded: false,
  });
}

export function recordMemoryUsage(state, usage, { config } = {}) {
  state.memoryAdmission = normalizeMemoryAdmission(state.memoryAdmission ?? {});
  const admission = state.memoryAdmission;
  const at = usage?.at ?? timestamp();
  const query = String(usage?.query ?? '').trim();
  const currentProjectName = usage?.currentProjectName ? String(usage.currentProjectName) : null;
  const queryFingerprint = buildQueryFingerprint(query, currentProjectName);
  const topResults = normalizeUsageResults(usage?.results ?? []);
  const touchedCandidateIds = [];

  admission.usageEvents = [
    {
      at,
      source: usage?.source === 'consult' ? 'consult' : 'query',
      mode: String(usage?.mode ?? 'local-only'),
      currentProjectName,
      queryFingerprint,
      query,
      topResultKeys: topResults.map((result) => result.resultKey),
      resultCount: topResults.length,
      localConfidence: usage?.localConfidence == null ? null : Number(usage.localConfidence),
      webResearchRecommended: usage?.webResearchRecommended == null ? null : Boolean(usage.webResearchRecommended),
    },
    ...(admission.usageEvents ?? []),
  ].slice(0, MAX_USAGE_EVENTS);

  for (const result of topResults) {
    const existing = admission.trackedResults[result.resultKey] ?? createTrackedResult(result, at);
    const updated = updateTrackedResult(existing, result, {
      at,
      queryFingerprint,
      currentProjectName,
      source: usage?.source === 'consult' ? 'consult' : 'query',
    });
    admission.trackedResults[result.resultKey] = updated;

    if (!meetsRepeatedUseThreshold(updated)) {
      continue;
    }

    if (isCanonicalPromotionSurface(result)) {
      if (!updated.canonicalSuppressionRecorded) {
        updated.canonicalSuppressionRecorded = true;
        admission.suppressionCounts.canonicalSurface += 1;
      }
      continue;
    }

    if (!isPromotionCandidateResult(result, updated)) {
      continue;
    }

    const candidate = buildAdmissionCandidate(updated, result);
    const existingIndex = admission.candidates.findIndex((entry) => entry.id === candidate.id);
    if (existingIndex >= 0) {
      admission.candidates[existingIndex] = {
        ...admission.candidates[existingIndex],
        ...candidate,
        firstQualifiedAt: admission.candidates[existingIndex].firstQualifiedAt ?? candidate.firstQualifiedAt,
      };
      admission.suppressionCounts.duplicateCandidate += 1;
    } else {
      admission.candidates = [candidate, ...(admission.candidates ?? [])];
    }
    touchedCandidateIds.push(candidate.id);
  }

  admission.candidates = [...(admission.candidates ?? [])]
    .sort(compareAdmissionCandidates)
    .slice(0, MAX_CANDIDATES);
  admission.trackedResults = pruneTrackedResults(admission.trackedResults, admission.candidates);

  return buildMemoryAdmissionPayload(state, {
    config,
    queryFingerprint,
    touchedResultKeys: topResults.map((result) => result.resultKey),
    touchedCandidateIds: uniqueStrings(touchedCandidateIds),
    recorded: true,
  });
}

export function getChangedProjects(state, projects) {
  return projects
    .filter((project) => {
      const previous = getProjectState(state, project.name);
      return !previous || previous.fingerprint !== project.fingerprint;
    })
    .map((project) => project.name);
}

export function summarizeProjectState(state) {
  return Object.values(state.projects)
    .map((project) => ({
      name: project.name,
      lastScannedAt: project.lastScannedAt ?? 'never',
      lastSyncedAt: project.lastSyncedAt ?? 'never',
      lastEmbeddedAt: project.lastEmbeddedAt ?? 'never',
      chunkCount: project.chunkCount ?? 0,
      status: project.status ?? 'unknown',
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getProjectCachePath(config, projectName) {
  return path.join(config.projectCacheRoot, `${projectName}.json`);
}

export function getChunkCachePath(config, projectName) {
  return path.join(config.chunkCacheRoot, `${projectName}.json`);
}

export async function cacheProjectSnapshot(config, project) {
  await writeJson(getProjectCachePath(config, project.name), project);
}

export async function loadCachedProjectSnapshot(config, projectName) {
  return readJson(getProjectCachePath(config, projectName), null);
}

export async function listCachedProjectSnapshots(config, projectNames = []) {
  const names = uniqueStrings(projectNames);
  if (names.length === 0) {
    return [];
  }
  const snapshots = await Promise.all(names.map((projectName) => loadCachedProjectSnapshot(config, projectName)));
  return snapshots.filter(Boolean);
}

export async function cacheProjectChunks(config, projectName, chunks) {
  await writeJson(getChunkCachePath(config, projectName), chunks);
}

export async function loadProjectChunks(config, projectName) {
  return readJson(getChunkCachePath(config, projectName), []);
}

export function summarizeMemoryAdmission(state, config = null) {
  const admission = normalizeMemoryAdmission(state.memoryAdmission ?? {});
  return {
    usageEventCount: admission.usageEvents.length,
    trackedResultCount: Object.keys(admission.trackedResults).length,
    candidateCount: admission.candidates.length,
    suppressedCanonicalCount: Number(admission.suppressionCounts?.canonicalSurface ?? 0),
    suppressedDuplicateCount: Number(admission.suppressionCounts?.duplicateCandidate ?? 0),
    latestEventAt: admission.usageEvents[0]?.at ?? null,
    topCandidates: admission.candidates.slice(0, 3).map((candidate) => buildCandidateView(candidate, config)),
  };
}

function buildMemoryAdmissionPayload(state, {
  config,
  queryFingerprint,
  touchedResultKeys = [],
  touchedCandidateIds = [],
  recorded,
}) {
  const summary = summarizeMemoryAdmission(state, config);
  const admission = normalizeMemoryAdmission(state.memoryAdmission ?? {});
  const touchedResultKeySet = new Set(touchedResultKeys);
  const touchedCandidateIdSet = new Set(touchedCandidateIds);
  const touchedCandidates = admission.candidates
    .filter((candidate) => touchedCandidateIdSet.size > 0
      ? touchedCandidateIdSet.has(candidate.id)
      : touchedResultKeySet.has(candidate.resultKey))
    .sort(compareAdmissionCandidates)
    .slice(0, 3)
    .map((candidate) => buildCandidateView(candidate, config));

  return {
    recorded,
    queryFingerprint,
    usageEventCount: summary.usageEventCount,
    trackedResultCount: summary.trackedResultCount,
    candidateCount: summary.candidateCount,
    suppressedCanonicalCount: summary.suppressedCanonicalCount,
    suppressedDuplicateCount: summary.suppressedDuplicateCount,
    touchedCandidates,
  };
}

function buildTouchedResultKeys(results) {
  return normalizeUsageResults(results ?? []).map((result) => result.resultKey);
}

function normalizeUsageResults(results) {
  return (results ?? [])
    .slice(0, 5)
    .map((result, index) => {
      const normalized = {
        index,
        project: String(result?.project ?? 'unknown'),
        noteType: String(result?.noteType ?? 'unknown'),
        sourcePath: String(result?.sourcePath ?? 'unknown'),
        sourceKind: String(result?.sourceKind ?? 'unknown'),
        snippet: String(result?.snippet ?? '').slice(0, 220),
        relevanceScore: Number(result?.relevanceScore ?? 0),
        evidenceQuality: String(result?.evidenceQuality ?? 'weak'),
        confidence: Number(result?.confidence ?? 0),
        supportCount: Number(result?.supportCount ?? 0),
      };
      return {
        ...normalized,
        resultKey: buildResultKey(normalized),
      };
    });
}

function buildResultKey(result) {
  return `${result.project}:${result.noteType}:${normalizePathValue(result.sourcePath)}`;
}

function createTrackedResult(result, at) {
  return {
    resultKey: result.resultKey,
    project: result.project,
    noteType: result.noteType,
    sourcePath: result.sourcePath,
    sourceKind: result.sourceKind,
    snippet: result.snippet,
    firstSeenAt: at,
    lastSeenAt: at,
    useCount: 0,
    queryUseCount: 0,
    consultUseCount: 0,
    topRankCount: 0,
    sameProjectUseCount: 0,
    strongEvidenceUseCount: 0,
    averageRelevanceScore: 0,
    evidenceQuality: result.evidenceQuality,
    confidence: result.confidence,
    supportCount: result.supportCount,
    distinctQueryFingerprints: [],
    canonicalSuppressionRecorded: false,
  };
}

function updateTrackedResult(existing, result, { at, queryFingerprint, currentProjectName, source }) {
  const nextUseCount = Number(existing.useCount ?? 0) + 1;
  const previousAverage = Number(existing.averageRelevanceScore ?? 0);
  return {
    ...existing,
    project: result.project,
    noteType: result.noteType,
    sourcePath: result.sourcePath,
    sourceKind: result.sourceKind,
    snippet: result.snippet,
    lastSeenAt: at,
    useCount: nextUseCount,
    queryUseCount: Number(existing.queryUseCount ?? 0) + Number(source === 'query'),
    consultUseCount: Number(existing.consultUseCount ?? 0) + Number(source === 'consult'),
    topRankCount: Number(existing.topRankCount ?? 0) + Number(result.index === 0),
    sameProjectUseCount: Number(existing.sameProjectUseCount ?? 0) + Number(Boolean(currentProjectName && result.project === currentProjectName)),
    strongEvidenceUseCount: Number(existing.strongEvidenceUseCount ?? 0) + Number(result.evidenceQuality === 'strong'),
    averageRelevanceScore: Number((((previousAverage * Number(existing.useCount ?? 0)) + result.relevanceScore) / nextUseCount).toFixed(4)),
    evidenceQuality: strongerEvidenceQuality(existing.evidenceQuality, result.evidenceQuality),
    confidence: Number(Math.max(Number(existing.confidence ?? 0), result.confidence).toFixed(4)),
    supportCount: Math.max(Number(existing.supportCount ?? 0), result.supportCount),
    distinctQueryFingerprints: uniqueStrings([...(existing.distinctQueryFingerprints ?? []), queryFingerprint]).slice(0, MAX_DISTINCT_QUERY_FINGERPRINTS),
  };
}

function meetsRepeatedUseThreshold(trackedResult) {
  return Number(trackedResult.useCount ?? 0) >= PROMOTION_MIN_USE_COUNT
    && Number(trackedResult.distinctQueryFingerprints?.length ?? 0) >= PROMOTION_MIN_DISTINCT_QUERIES
    && Number(trackedResult.averageRelevanceScore ?? 0) >= PROMOTION_MIN_AVERAGE_RELEVANCE;
}

function isPromotionCandidateResult(result, trackedResult) {
  return result.noteType === 'normalized-project'
    || (trackedResult.sourceKind !== 'note' && !isCanonicalPromotionSurface(result));
}

function isCanonicalPromotionSurface(result) {
  const sourcePath = normalizePathValue(result.sourcePath);
  if (isCanonicalKnowledgeBasePath(sourcePath)) {
    return true;
  }
  return /\/01_Projects\/[^/]+\/(?:overview|architecture|learnings|prompts)\.md$/i.test(sourcePath);
}

function buildAdmissionCandidate(trackedResult, result) {
  const distinctQueryCount = Number(trackedResult.distinctQueryFingerprints?.length ?? 0);
  const targetType = trackedResult.sameProjectUseCount >= 2 && trackedResult.project !== 'unknown'
    ? 'project-learning'
    : 'reusable-pattern';
  const score = Number((
    (distinctQueryCount * 1.4)
    + (Number(trackedResult.topRankCount ?? 0) * 0.85)
    + (Number(trackedResult.consultUseCount ?? 0) * 0.9)
    + (Number(trackedResult.strongEvidenceUseCount ?? 0) * 0.3)
    + Number(trackedResult.averageRelevanceScore ?? 0)
  ).toFixed(2));

  return {
    id: sha256(trackedResult.resultKey),
    resultKey: trackedResult.resultKey,
    project: trackedResult.project,
    noteType: trackedResult.noteType,
    sourcePath: trackedResult.sourcePath,
    sourceKind: trackedResult.sourceKind,
    summary: result.snippet,
    firstQualifiedAt: trackedResult.lastSeenAt,
    lastSeenAt: trackedResult.lastSeenAt,
    useCount: trackedResult.useCount,
    distinctQueryCount,
    queryUseCount: trackedResult.queryUseCount,
    consultUseCount: trackedResult.consultUseCount,
    topRankCount: trackedResult.topRankCount,
    averageRelevanceScore: trackedResult.averageRelevanceScore,
    evidenceQuality: trackedResult.evidenceQuality,
    confidence: trackedResult.confidence,
    supportCount: trackedResult.supportCount,
    score,
    targetType,
    targetProjectName: targetType === 'project-learning' ? trackedResult.project : null,
  };
}

function buildCandidateView(candidate, config) {
  return {
    id: candidate.id,
    project: candidate.project,
    noteType: candidate.noteType,
    sourcePath: candidate.sourcePath,
    score: candidate.score,
    useCount: candidate.useCount,
    distinctQueryCount: candidate.distinctQueryCount,
    targetType: candidate.targetType,
    targetProjectName: candidate.targetProjectName,
    targetPath: resolveCandidateTargetPath(candidate, config),
    summary: candidate.summary,
  };
}

function resolveCandidateTargetPath(candidate, config) {
  if (!config) {
    return null;
  }
  if (candidate.targetType === 'project-learning' && candidate.targetProjectName) {
    return path.join(config.vaultRoot, '01_Projects', candidate.targetProjectName, 'learnings.md');
  }
  if (candidate.targetType === 'reusable-pattern') {
    return path.join(config.vaultRoot, '04_Knowledge_Base', 'reusable-patterns.md');
  }
  return null;
}

function pruneTrackedResults(trackedResults, candidates) {
  const entries = Object.entries(trackedResults ?? {});
  if (entries.length <= MAX_TRACKED_RESULTS) {
    return trackedResults;
  }
  const candidateKeys = new Set((candidates ?? []).map((candidate) => candidate.resultKey));
  return Object.fromEntries(entries
    .sort((left, right) => {
      const leftCandidate = Number(candidateKeys.has(left[0]));
      const rightCandidate = Number(candidateKeys.has(right[0]));
      if (rightCandidate !== leftCandidate) {
        return rightCandidate - leftCandidate;
      }
      const rightLastSeen = String(right[1]?.lastSeenAt ?? '');
      const leftLastSeen = String(left[1]?.lastSeenAt ?? '');
      if (rightLastSeen !== leftLastSeen) {
        return rightLastSeen.localeCompare(leftLastSeen);
      }
      return Number(right[1]?.useCount ?? 0) - Number(left[1]?.useCount ?? 0);
    })
    .slice(0, MAX_TRACKED_RESULTS));
}

function compareAdmissionCandidates(left, right) {
  return Number(right.score ?? 0) - Number(left.score ?? 0)
    || Number(right.useCount ?? 0) - Number(left.useCount ?? 0)
    || String(right.lastSeenAt ?? '').localeCompare(String(left.lastSeenAt ?? ''));
}

function strongerEvidenceQuality(left = 'weak', right = 'weak') {
  const rank = { weak: 1, medium: 2, strong: 3 };
  return (rank[right] ?? 1) > (rank[left] ?? 1) ? right : left;
}

function normalizePathValue(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function buildQueryFingerprint(query, currentProjectName) {
  const normalizedQuery = tokenize(String(query ?? '')).join(' ') || String(query ?? '').trim().toLowerCase();
  return sha256(`${currentProjectName ?? 'global'}|${normalizedQuery}`);
}