import path from 'node:path';

import {
  ensureDir,
  readJson,
  timestamp,
  uniqueStrings,
  writeJson,
} from '../shared/index.mjs';
import { isCanonicalKnowledgeBasePath } from '../vault-contract/index.mjs';

const STATE_VERSION = 2;

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
    lastScanAt: baseState.lastScanAt ?? null,
    lastSyncAt: baseState.lastSyncAt ?? null,
    lastEmbedAt: baseState.lastEmbedAt ?? null,
    lastLearnAt: baseState.lastLearnAt ?? null,
  };
}

function normalizeQueryHistory(entries) {
  return (entries ?? []).map((entry) => ({
    ...entry,
    topResultIds: (entry.topResultIds ?? []).filter((value) => isCanonicalTopResultId(value)),
  }));
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
  ].slice(0, 120);
}

export function recordFailure(state, details) {
  state.failures = [
    {
      at: timestamp(),
      ...details,
    },
    ...(state.failures ?? []),
  ].slice(0, 120);
}

export function recordQuery(state, queryRecord) {
  state.queryHistory = [queryRecord, ...(state.queryHistory ?? [])].slice(0, 100);
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