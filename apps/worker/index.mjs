import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { LocalSemanticEmbedder, summarizeEmbeddingBatch } from '../../packages/embeddings/index.mjs';
import { consultBrain, searchBrain } from '../../packages/brain-service/index.mjs';
import { ChromaVectorStore } from '../../packages/vector-store/index.mjs';
import { bootstrapVault, readProjectNoteContents, syncNotes, writeManagedKnowledgeNotes } from '../../packages/obsidian-writer/index.mjs';
import { reasonAboutQuery } from '../../packages/reasoner/index.mjs';
import { retrieveContext } from '../../packages/retriever/index.mjs';
import { scanWorkspace } from '../../packages/scanner/index.mjs';
import {
  cacheProjectChunks,
  cacheProjectSnapshot,
  getChangedProjects,
  getProjectState,
  listCachedProjectSnapshots,
  loadProjectChunks,
  loadState,
  recordFailure,
  recordOperation,
  recordQuery,
  saveState,
  setProjectState,
} from '../../packages/state-manager/index.mjs';
import { buildProjectKnowledgeSources, chunkProjectKnowledge } from '../../packages/chunker/index.mjs';
import {
  appendLog,
  buildLogPath,
  buildRuntimeConfig,
  createOperationSummary,
  extractProjectNames,
  timestamp,
} from '../../packages/shared/index.mjs';
import { isCanonicalKnowledgeBasePath, renderVaultValidationReport, validateVaultContract } from '../../packages/vault-contract/index.mjs';
import { startWatchLoop } from '../../packages/watcher/index.mjs';

const KNOWLEDGE_MODEL_VERSION = 'canonical-v1';
const execFileAsync = promisify(execFile);

export async function runInit(options = {}) {
  const config = buildRuntimeConfig(options);
  const state = await loadState(config);
  await bootstrapVault(config);
  recordOperation(state, 'init', { summary: 'Initialized brain runtime and vault bootstrap.' });
  await saveState(config, state);
  await appendLog(buildLogPath(config), 'brain init completed');
  return { config, state };
}

export async function runScan(options = {}) {
  const config = buildRuntimeConfig(options);
  const state = await loadState(config);
  const scanResult = await scanWorkspace(config, {
    projectNames: options.projectNames ?? extractProjectNames(options),
    includeBrain: config.includeBrain,
    force: config.force,
  });

  const changedProjects = config.force ? scanResult.projects.map((project) => project.name) : getChangedProjects(state, scanResult.projects);
  for (const project of scanResult.projects) {
    await cacheProjectSnapshot(config, project);
    const previous = getProjectState(state, project.name);
    setProjectState(state, project.name, {
      ...(previous ?? {}),
      name: project.name,
      rootPath: project.rootPath,
      fingerprint: project.fingerprint,
      summary: project.summary,
      techStack: project.stack,
      architecturePatterns: project.architecture,
      tags: project.tags,
      status: 'scanned',
      lastScannedAt: scanResult.completedAt,
      chunkCount: previous?.chunkCount ?? 0,
    });
  }

  for (const failure of scanResult.failures) {
    recordFailure(state, failure);
  }

  state.lastScanAt = scanResult.completedAt;
  recordOperation(state, 'scan', {
    projects: scanResult.projects.map((project) => project.name),
    unchangedCount: Math.max(scanResult.projects.length - changedProjects.length, 0),
    summary: createOperationSummary(changedProjects, 'changed project'),
  });
  await saveState(config, state);
  await appendLog(buildLogPath(config), `scan completed for ${scanResult.projects.length} project(s)`);
  return { config, state, scanResult, changedProjects };
}

export async function runSync(options = {}) {
  const { config, state, scanResult, changedProjects } = await runScan(options);
  const syncSummary = await syncNotes(config, state, scanResult.projects, {
    changedProjects,
    trigger: options.trigger ?? 'sync',
    failures: scanResult.failures,
  });

  for (const project of scanResult.projects) {
    const previous = getProjectState(state, project.name);
    setProjectState(state, project.name, {
      ...(previous ?? {}),
      lastSyncedAt: syncSummary.completedAt,
      status: 'synced',
      history: [
        {
          syncedAt: syncSummary.completedAt,
          trigger: syncSummary.trigger,
          note: project.summary,
        },
        ...((previous?.history ?? []).slice(0, 19)),
      ],
    });
  }

  state.lastSyncAt = syncSummary.completedAt;
  recordOperation(state, 'sync', {
    projects: changedProjects,
    unchangedCount: syncSummary.unchangedProjects.length,
    summary: createOperationSummary(changedProjects, 'synced project'),
  });
  await saveState(config, state);
  await appendLog(buildLogPath(config), `sync completed for ${scanResult.projects.length} project(s)`);
  return { config, state, scanResult, changedProjects, syncSummary };
}

export async function runEmbed(options = {}) {
  const config = buildRuntimeConfig(options);
  const state = await loadState(config);
  const projectNames = options.projectNames ?? extractProjectNames(options);
  let projects = await listCachedProjectSnapshots(config, projectNames.length > 0 ? projectNames : Object.keys(state.projects));

  if (projects.length === 0) {
    const syncResult = await runSync(options);
    projects = syncResult.scanResult.projects;
  }

  const embedder = new LocalSemanticEmbedder({ pythonExecutable: config.pythonExecutable });
  const vectorStore = new ChromaVectorStore(config);
  const vectorStatus = await vectorStore.ensureCollection();
  if (vectorStatus.ok === false) {
    throw new Error(vectorStatus.error ?? 'Chroma collection bootstrap failed.');
  }

  const embeddedProjects = [];
  for (const project of projects) {
    const currentState = getProjectState(state, project.name);
    if (!config.force
      && currentState?.embeddedFingerprint === project.fingerprint
      && currentState?.embeddingBackend === embedder.backendId
      && currentState?.knowledgeModelVersion === KNOWLEDGE_MODEL_VERSION) {
      continue;
    }

    const noteContents = await readProjectNoteContents(config, project);
    const sources = buildProjectKnowledgeSources(project, noteContents);
    const chunks = chunkProjectKnowledge(project, sources);
    const previousChunks = await loadProjectChunks(config, project.name);
    const previousIds = new Set(previousChunks.map((chunk) => chunk.id));
    const nextIds = new Set(chunks.map((chunk) => chunk.id));
    const deletedIds = [...previousIds].filter((id) => !nextIds.has(id));
    if (deletedIds.length > 0) {
      await vectorStore.deleteIds(deletedIds);
    }

    const embeddings = await embedder.embedTexts(chunks.map((chunk) => chunk.content));
    await vectorStore.upsert(chunks, embeddings);
    await cacheProjectChunks(config, project.name, chunks);

    setProjectState(state, project.name, {
      ...(currentState ?? {}),
      chunkCount: chunks.length,
      embeddedFingerprint: project.fingerprint,
      embeddingBackend: embedder.backendId,
      knowledgeModelVersion: KNOWLEDGE_MODEL_VERSION,
      embeddingDimensions: embeddings[0]?.length ?? null,
      lastEmbeddedAt: timestamp(),
      status: 'embedded',
    });
    embeddedProjects.push({
      name: project.name,
      ...summarizeEmbeddingBatch(chunks, embeddings),
    });
  }

  state.lastEmbedAt = timestamp();
  recordOperation(state, 'embed', {
    projects: embeddedProjects.map((project) => project.name),
    summary: createOperationSummary(embeddedProjects.map((project) => project.name), 'embedded project'),
  });
  await saveState(config, state);
  await writeManagedKnowledgeNotes(config, state, projects);
  await appendLog(buildLogPath(config), `embed completed for ${embeddedProjects.length} project(s)`);
  return { config, state, embeddedProjects };
}

export async function runLearn(options = {}) {
  const config = buildRuntimeConfig(options);
  const state = await loadState(config);
  const projectNames = options.projectNames ?? extractProjectNames(options);
  const projects = await listCachedProjectSnapshots(config, projectNames.length > 0 ? projectNames : Object.keys(state.projects));
  await writeManagedKnowledgeNotes(config, state, projects);
  state.lastLearnAt = timestamp();
  recordOperation(state, 'learn', {
    projects: projects.map((project) => project.name),
    summary: createOperationSummary(projects.map((project) => project.name), 'learned project snapshot'),
  });
  await saveState(config, state);
  await appendLog(buildLogPath(config), `learn completed for ${projects.length} project(s)`);
  return { config, state, projects };
}

export async function runQuery(options = {}) {
  const config = buildRuntimeConfig(options);
  const state = await loadState(config);
  const queryText = String(options.queryText ?? '').trim();
  if (!queryText) {
    throw new Error('Query text is required.');
  }

  const embedder = new LocalSemanticEmbedder({ pythonExecutable: config.pythonExecutable });
  const vectorStore = new ChromaVectorStore(config);
  const retrievalResponse = await retrieveContext({
    queryText,
    topK: config.topK,
    embedder,
    vectorStore,
  });
  const reasoning = await reasonAboutQuery(config, state, retrievalResponse);
  const queryRecord = {
    at: timestamp(),
    query: queryText,
    mode: reasoning.mode,
    relatedProjects: reasoning.relatedProjects,
    topResultIds: retrievalResponse.results.slice(0, 5).map((result) => result.id),
  };
  recordQuery(state, queryRecord);
  recordOperation(state, 'query', {
    projects: reasoning.relatedProjects,
    summary: `Query '${queryText}' matched ${reasoning.relatedProjects.join(', ') || 'no projects'}`,
  });
  await saveState(config, state);
  const projects = await listCachedProjectSnapshots(config, Object.keys(state.projects));
  await writeManagedKnowledgeNotes(config, state, projects);
  await appendLog(buildLogPath(config), `query completed: ${queryText}`);
  return {
    config,
    state,
    retrievalResponse,
    reasoning,
  };
}

export async function runConsult(options = {}) {
  const config = buildRuntimeConfig(options);
  const queryText = String(options.queryText ?? '').trim();
  if (!queryText) {
    throw new Error('Query text is required.');
  }

  const payload = await consultBrain({
    query: queryText,
    currentProjectName: options.currentProjectName ?? options.projectNames?.[0] ?? null,
    currentProjectPath: options.currentProjectPath,
    topK: config.topK,
    runtimeOptions: options,
  });

  await appendLog(buildLogPath(config), `consult completed: ${queryText}`);
  return {
    config,
    consultation: payload,
  };
}

export async function runStatus(options = {}) {
  const config = buildRuntimeConfig(options);
  const state = await loadState(config);
  const vectorStore = new ChromaVectorStore(config);
  let vectorStatus;
  try {
    vectorStatus = await vectorStore.status();
  } catch (error) {
    vectorStatus = {
      ok: false,
      error: error.message,
    };
  }
  return {
    config,
    state,
    vectorStatus,
  };
}

export async function runValidateVault(options = {}) {
  const config = buildRuntimeConfig(options);
  const state = await loadState(config);
  const report = await validateVaultContract(config.vaultRoot);
  const reportText = renderVaultValidationReport(report);

  recordOperation(state, 'validate-vault', {
    summary: report.ok
      ? `Vault validation passed for ${report.projectCount} project folders`
      : `Vault validation failed with ${report.issues.length} issue(s)`,
  });
  await saveState(config, state);
  await appendLog(buildLogPath(config), `vault validation ${report.ok ? 'passed' : 'failed'} with ${report.issues.length} issue(s)`);

  return {
    config,
    state,
    report,
    reportText,
  };
}

export async function runDoctor(options = {}) {
  const config = buildRuntimeConfig(options);
  const state = await loadState(config);
  const report = await validateVaultContract(config.vaultRoot);
  const issues = [];
  const warnings = [];
  const projectNames = Object.keys(state.projects ?? {});
  const canonicalSurfaceViolations = [];

  for (const [projectName, projectState] of Object.entries(state.projects ?? {})) {
    if ((projectState.chunkCount ?? 0) > 0 && projectState.knowledgeModelVersion !== KNOWLEDGE_MODEL_VERSION) {
      issues.push(`Project ${projectName} is embedded with knowledge model ${projectState.knowledgeModelVersion ?? 'missing'} instead of ${KNOWLEDGE_MODEL_VERSION}.`);
    }
    const chunks = await loadProjectChunks(config, projectName);
    for (const chunk of chunks) {
      if (chunk.noteType === 'logs' || (chunk.noteType === 'knowledge' && !isCanonicalKnowledgeBasePath(String(chunk.sourcePath ?? '')))) {
        canonicalSurfaceViolations.push(`${projectName}:${chunk.noteType}:${chunk.sourcePath}`);
      }
      if (String(chunk.sourcePath ?? '').includes('04_Knowledge_Base/') && !isCanonicalKnowledgeBasePath(String(chunk.sourcePath ?? ''))) {
        canonicalSurfaceViolations.push(`${projectName}:${chunk.noteType}:${chunk.sourcePath}`);
      }
    }
  }

  if (canonicalSurfaceViolations.length > 0) {
    issues.push(`Deprecated retrieval surfaces still exist in chunk cache: ${canonicalSurfaceViolations.slice(0, 5).join(', ')}${canonicalSurfaceViolations.length > 5 ? ' ...' : ''}`);
  }

  if (projectNames.length === 0) {
    warnings.push('No indexed projects exist yet. Run brain:sync and brain:embed before trusting retrieval.');
  }

  let queryCheck = null;
  let consultCheck = null;
  const smokeProjectName = state.projects?.brain ? 'brain' : (projectNames[0] ?? null);

  if ((state.lastEmbedAt ?? null) === null) {
    warnings.push('No embeddings have been created yet. Run brain:embed before relying on query or consult.');
  } else {
    queryCheck = await searchBrain({
      query: 'reusable pattern',
      currentProjectName: smokeProjectName,
      topK: 5,
      runtimeOptions: options,
    });
    if (queryCheck.results.length === 0) {
      issues.push('Query smoke test returned no results.');
    }
    if (queryCheck.results.length > 0) {
      const topResult = queryCheck.results[0];
      if (!topResult.evidenceQuality || typeof topResult.confidence !== 'number') {
        issues.push('Query smoke test returned results without provenance-aware trust fields.');
      }
      if (!Array.isArray(topResult.supportingSources)) {
        issues.push('Query smoke test returned results without supporting evidence traces.');
      }
    }
    const deprecatedQueryResult = queryCheck.results.find((result) => {
      if (result.noteType === 'logs' || (result.noteType === 'knowledge' && !isCanonicalKnowledgeBasePath(String(result.sourcePath ?? '')))) {
        return true;
      }
      return String(result.sourcePath ?? '').includes('04_Knowledge_Base/') && !isCanonicalKnowledgeBasePath(String(result.sourcePath ?? ''));
    });
    if (deprecatedQueryResult) {
      issues.push(`Query smoke test returned a deprecated surface: ${deprecatedQueryResult.project}/${deprecatedQueryResult.noteType} -> ${deprecatedQueryResult.sourcePath}`);
    }

    consultCheck = await consultBrain({
      query: 'best practice for token refresh handling',
      currentProjectName: smokeProjectName,
      topK: 5,
      runtimeOptions: options,
    });
    if (!['local-only', 'local-plus-web-assist', 'web-first-local-adaptation'].includes(consultCheck.mode)) {
      issues.push(`Consult smoke test returned an invalid mode: ${consultCheck.mode}`);
    }
    if (consultCheck.researchDecision.needsWebResearch !== true) {
      issues.push('Consult smoke test did not recommend web research for a current auth best-practice query.');
    }
    if (!consultCheck.trustSummary || !Array.isArray(consultCheck.evidence?.topResults)) {
      issues.push('Consult smoke test returned without provenance-aware trust summary fields.');
    }
  }

  let mcpHealth = { ok: false, tools: [], stdout: '', error: null };
  try {
    const healthcheckArgs = [path.join(config.brainRoot, 'apps', 'mcp-server', 'index.mjs'), '--healthcheck'];
    if (options.configPath) healthcheckArgs.push('--config', options.configPath);
    if (options.projectsRoot) healthcheckArgs.push('--projects-root', options.projectsRoot);
    if (options.vaultRoot) healthcheckArgs.push('--vault-root', options.vaultRoot);
    if (options.dataRoot) healthcheckArgs.push('--data-root', options.dataRoot);
    if (options.cacheRoot) healthcheckArgs.push('--cache-root', options.cacheRoot);
    if (options.chromaRoot) healthcheckArgs.push('--chroma-root', options.chromaRoot);
    if (options.logRoot) healthcheckArgs.push('--log-root', options.logRoot);
    if (options.statePath) healthcheckArgs.push('--state-path', options.statePath);
    if (options.pythonExecutable) healthcheckArgs.push('--python', options.pythonExecutable);
    const { stdout } = await execFileAsync(process.execPath, healthcheckArgs, {
      cwd: config.brainRoot,
      env: process.env,
      timeout: 30000,
    });
    const toolsLine = String(stdout ?? '').split('\n').find((line) => line.startsWith('Tools:')) ?? '';
    const tools = toolsLine.replace(/^Tools:\s*/, '').split(',').map((item) => item.trim()).filter(Boolean);
    mcpHealth = { ok: true, tools, stdout: String(stdout ?? '').trim(), error: null };
  } catch (error) {
    mcpHealth = { ok: false, tools: [], stdout: '', error: error.message };
    issues.push(`MCP healthcheck failed: ${error.message}`);
  }

  const expectedTools = [
    'brain.search',
    'brain.consult',
    'brain.synthesize_guidance',
    'brain.project_summary',
    'brain.related_patterns',
    'brain.recent_learnings',
    'brain.capture_learning',
    'brain.capture_research_candidate',
  ];
  const missingTools = expectedTools.filter((toolName) => !mcpHealth.tools.includes(toolName));
  if (mcpHealth.ok && missingTools.length > 0) {
    issues.push(`MCP healthcheck is missing expected tools: ${missingTools.join(', ')}`);
  }

  const ok = report.ok && issues.length === 0;
  const summary = ok
    ? `Doctor passed: ${projectNames.length} indexed project(s), canonical vault contract valid, MCP healthy.`
    : `Doctor failed with ${issues.length} issue(s).`;

  recordOperation(state, 'doctor', { summary });
  await saveState(config, state);
  await appendLog(buildLogPath(config), `doctor ${ok ? 'passed' : 'failed'} | issues=${issues.length} | warnings=${warnings.length}`);

  return {
    config,
    report,
    ok,
    issues,
    warnings,
    queryCheck: queryCheck ? {
      resultCount: queryCheck.results.length,
      topNoteTypes: queryCheck.results.slice(0, 5).map((result) => result.noteType),
    } : null,
    consultCheck: consultCheck ? {
      mode: consultCheck.mode,
      needsWebResearch: consultCheck.researchDecision.needsWebResearch,
    } : null,
    mcpHealth,
    summary,
  };
}

export async function runWatch(options = {}) {
  const config = buildRuntimeConfig(options);
  await startWatchLoop(config, async (projectNames, trigger) => {
    await runSync({ ...options, projectNames, trigger });
    await runEmbed({ ...options, projectNames });
    await runLearn({ ...options, projectNames });
  });
}