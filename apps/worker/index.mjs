import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { LocalSemanticEmbedder, prewarmEmbeddingService, summarizeEmbeddingBatch } from '../../packages/embeddings/index.mjs';
import { consultBrain, searchBrain } from '../../packages/brain-service/index.mjs';
import { buildProjectGraph } from '../../packages/project-graph/index.mjs';
import {
  buildRunnerStatusSummary,
  createCliSemanticEmbedder,
  describeEmbedderRuntime,
  inspectEmbedderRunner,
  resolveCliEmbedderSelection,
  restartEmbedderRunner,
  startEmbedderRunner,
  stopEmbedderRunner,
} from '../../packages/embedder-runner/index.mjs';
import { ChromaVectorStore } from '../../packages/vector-store/index.mjs';
import {
  bootstrapVault,
  readGlobalKnowledgeNoteContents,
  readProjectNoteContents,
  syncNotes,
  writeManagedKnowledgeNotes,
} from '../../packages/obsidian-writer/index.mjs';
import { reasonAboutQuery } from '../../packages/reasoner/index.mjs';
import { retrieveContext } from '../../packages/retriever/index.mjs';
import { scanWorkspace } from '../../packages/scanner/index.mjs';
import {
  cacheProjectChunks,
  cacheProjectSnapshot,
  getChangedProjects,
  getLastLearningActivityAt,
  getLatestOperation,
  getProjectState,
  listCachedProjectSnapshots,
  loadProjectChunks,
  saveProjectGraph,
  loadState,
  recordMemoryUsage,
  recordFailure,
  recordOperation,
  recordQuery,
  saveState,
  setProjectState,
  summarizeMemoryAdmission,
  upsertInvalidationEntry,
} from '../../packages/state-manager/index.mjs';
import {
  buildGlobalKnowledgeSources,
  buildProjectKnowledgeSources,
  chunkProjectKnowledge,
  GLOBAL_KNOWLEDGE_CACHE_KEY,
  GLOBAL_KNOWLEDGE_PROJECT_NAME,
} from '../../packages/chunker/index.mjs';
import {
  appendLog,
  buildLogPath,
  buildRuntimeConfig,
  createOperationSummary,
  extractProjectNames,
  sha256,
  tokenize,
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
    if (previous?.fingerprint && previous.fingerprint !== project.fingerprint) {
      await upsertInvalidationEntry(config, {
        projectName: project.name,
        fingerprint: project.fingerprint,
        triggeredAt: scanResult.completedAt,
        staleReasons: ['project fingerprint changed after scan'],
        affectedArtifacts: ['episodes', 'distillation-candidates', 'prompt-patterns', 'causal-graph'],
        status: 'active',
      });
    }
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

  await saveProjectGraph(config, buildProjectGraph(scanResult.projects));

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
  const knowledgeProjects = await loadManagedKnowledgeProjects(config, state, scanResult.projects);
  const syncSummary = await syncNotes(config, state, scanResult.projects, {
    changedProjects,
    trigger: options.trigger ?? 'sync',
    failures: scanResult.failures,
    knowledgeProjects,
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
  const embedderPrewarmHandle = startEmbedderPrewarm(config, 'embed');
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
  const embedderPrewarm = await embedderPrewarmHandle.promise;
  recordEmbedderPrewarmOperation(state, embedderPrewarm);
  recordOperation(state, 'embed', {
    projects: embeddedProjects.map((project) => project.name),
    summary: createOperationSummary(embeddedProjects.map((project) => project.name), 'embedded project'),
  });
  await saveState(config, state);
  const knowledgeProjects = await loadManagedKnowledgeProjects(config, state, projects);
  await writeManagedKnowledgeNotes(config, state, knowledgeProjects);
  const globalKnowledgeEmbedding = await syncGlobalKnowledgeEmbeddings(config, embedder, vectorStore);
  await appendLog(buildLogPath(config), `embed completed for ${embeddedProjects.length} project(s); global knowledge chunks=${globalKnowledgeEmbedding.chunkCount}`);
  return { config, state, embeddedProjects, embedderPrewarm };
}

export async function runLearn(options = {}) {
  const config = buildRuntimeConfig(options);
  const state = await loadState(config);
  const projectNames = options.projectNames ?? extractProjectNames(options);
  const projects = await listCachedProjectSnapshots(config, projectNames.length > 0 ? projectNames : Object.keys(state.projects));
  const knowledgeProjects = await loadManagedKnowledgeProjects(config, state, projects);
  await writeManagedKnowledgeNotes(config, state, knowledgeProjects);
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
  const embedderSelection = await resolveCliEmbedderSelection(config, {
    command: 'query',
    allowAutoStart: true,
  });
  const embedderPrewarmHandle = startCommandEmbedderPrewarm(config, 'query', embedderSelection);
  const state = await loadState(config);
  const queryText = String(options.queryText ?? '').trim();
  if (!queryText) {
    throw new Error('Query text is required.');
  }
  const currentProjectName = options.currentProjectName ?? options.projectNames?.[0] ?? '';

  const embedder = createCliSemanticEmbedder(config, {
    selection: embedderSelection,
  });
  const vectorStore = new ChromaVectorStore(config);
  const retrievalResponse = await retrieveContext({
    queryText,
    topK: config.topK,
    embedder,
    vectorStore,
    currentProjectName,
  });
  const reasoning = await reasonAboutQuery(config, state, retrievalResponse);
  const queryRecord = {
    at: timestamp(),
    query: queryText,
    mode: reasoning.mode,
    relatedProjects: reasoning.relatedProjects,
    topResultIds: retrievalResponse.results.slice(0, 5).map((result) => result.id),
  };
  const memoryAdmission = recordMemoryUsage(state, {
    at: queryRecord.at,
    source: 'query',
    query: queryText,
    currentProjectName,
    mode: reasoning.mode,
    results: retrievalResponse.results,
  }, { config });
  recordQuery(state, queryRecord);
  recordOperation(state, 'query', {
    projects: reasoning.relatedProjects,
    summary: `Query '${queryText}' matched ${reasoning.relatedProjects.join(', ') || 'no projects'}`,
  });
  await saveState(config, state);
  await appendLog(buildLogPath(config), `query completed: ${queryText}`);
  const embedderPrewarm = await embedderPrewarmHandle.promise;
  const embedderRuntime = describeEmbedderRuntime(embedder, embedderSelection);
  return {
    config,
    state,
    retrievalResponse,
    reasoning,
    memoryAdmission,
    embedderPrewarm,
    embedderRuntime,
    embedderRunner: buildEmbedderRunnerReport(config, embedderSelection, embedderRuntime),
  };
}

export async function runConsult(options = {}) {
  const config = buildRuntimeConfig(options);
  const embedderSelection = await resolveCliEmbedderSelection(config, {
    command: 'consult',
    allowAutoStart: true,
  });
  const embedderPrewarmHandle = startCommandEmbedderPrewarm(config, 'consult', embedderSelection);
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
    embedderSelection,
    includeEmbedderRuntime: true,
  });

  await appendLog(buildLogPath(config), `consult completed: ${queryText}`);
  const embedderPrewarm = await embedderPrewarmHandle.promise;
  return {
    config,
    consultation: payload,
    embedderPrewarm,
    embedderRuntime: payload.embedderRuntime ?? null,
    embedderRunner: buildEmbedderRunnerReport(config, embedderSelection, payload.embedderRuntime ?? null),
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
    lastLearningAt: getLastLearningActivityAt(state),
    memoryAdmission: summarizeMemoryAdmission(state, config),
    embedderPrewarm: summarizeEmbedderPrewarmState(state, config),
    embedderRunner: await inspectEmbedderRunner(config),
  };
}

export async function runEmbedderRunnerStart(options = {}) {
  const config = buildRuntimeConfig(options);
  const result = await startEmbedderRunner(config, { reason: 'CLI runner-start command' });
  return {
    config,
    runnerStatus: result.status,
    action: result.action,
    durationMs: result.durationMs,
    summary: buildRunnerStatusSummary(result.status),
  };
}

export async function runEmbedderRunnerStop(options = {}) {
  const config = buildRuntimeConfig(options);
  const result = await stopEmbedderRunner(config, { reason: 'CLI runner-stop command' });
  return {
    config,
    runnerStatus: result.status,
    action: result.action,
    summary: buildRunnerStatusSummary(result.status),
  };
}

export async function runEmbedderRunnerRestart(options = {}) {
  const config = buildRuntimeConfig(options);
  const result = await restartEmbedderRunner(config, { reason: 'CLI runner-restart command' });
  return {
    config,
    runnerStatus: result.status,
    action: result.action,
    durationMs: result.durationMs,
    summary: buildRunnerStatusSummary(result.status),
  };
}

export async function runEmbedderRunnerStatus(options = {}) {
  const config = buildRuntimeConfig(options);
  const runnerStatus = await inspectEmbedderRunner(config);
  return {
    config,
    runnerStatus,
    summary: buildRunnerStatusSummary(runnerStatus),
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
  const embedderSelection = await resolveCliEmbedderSelection(config, {
    command: 'doctor',
    allowAutoStart: false,
  });
  const embedderPrewarm = await startCommandEmbedderPrewarm(config, 'doctor', embedderSelection).promise;
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

  if (embedderPrewarm.outcome !== 'skipped') {
    recordEmbedderPrewarmOperation(state, embedderPrewarm);
  }
  if (embedderSelection.backend === 'runner' && embedderSelection.startup?.error) {
    warnings.push(`Embedder runner start failed: ${embedderSelection.startup.error}`);
  }
  if (embedderPrewarm.outcome === 'timed-out') {
    warnings.push(`Embedder prewarm timed out after ${embedderPrewarm.timeoutMs}ms; a fresh process may still pay the cold-start cost on its first retrieval.`);
  }
  if (embedderPrewarm.outcome === 'failed') {
    warnings.push(`Embedder prewarm failed: ${embedderPrewarm.error}`);
  }

  if (projectNames.length === 0) {
    warnings.push('No indexed projects exist yet. Run brain:sync and brain:embed before trusting retrieval.');
  }

  const globalKnowledgeChunks = await loadProjectChunks(config, GLOBAL_KNOWLEDGE_CACHE_KEY);
  if ((state.lastEmbedAt ?? null) !== null) {
    if (globalKnowledgeChunks.length === 0) {
      issues.push('Global knowledge-base notes are not embedded. Run brain:embed to index reusable-patterns and documentation-style-patterns.');
    } else {
      const invalidKnowledgeChunk = globalKnowledgeChunks.find((chunk) => chunk.noteType !== 'knowledge' || !isCanonicalKnowledgeBasePath(String(chunk.sourcePath ?? '')));
      if (invalidKnowledgeChunk) {
        issues.push(`Global knowledge chunk cache contains a non-canonical entry: ${invalidKnowledgeChunk.sourcePath}`);
      }
    }
  }

  let queryCheck = null;
  let consultCheck = null;
  let retrievalDiagnostics = null;
  let queryCheckLatencyMs = null;
  let consultCheckLatencyMs = null;
  const smokeProjectName = state.projects?.brain ? 'brain' : (projectNames[0] ?? null);

  if ((state.lastEmbedAt ?? null) === null) {
    warnings.push('No embeddings have been created yet. Run brain:embed before relying on query or consult.');
  } else {
    const queryCheckStartedAt = Date.now();
    queryCheck = await searchBrain({
      query: 'reusable pattern',
      currentProjectName: smokeProjectName,
      topK: 5,
      runtimeOptions: options,
      recordUsage: false,
      includeRelatedPatterns: false,
      includeRecentLearnings: false,
      includeEmbedderRuntime: true,
      embedderSelection,
    });
    queryCheckLatencyMs = Date.now() - queryCheckStartedAt;
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

    const consultCheckStartedAt = Date.now();
    consultCheck = await consultBrain({
      query: 'best practice for token refresh handling',
      currentProjectName: smokeProjectName,
      topK: 5,
      runtimeOptions: options,
      recordUsage: false,
      includeEmbedderRuntime: true,
      embedderSelection,
    });
    consultCheckLatencyMs = Date.now() - consultCheckStartedAt;
    if (!['local-only', 'local-plus-web-assist', 'web-first-local-adaptation'].includes(consultCheck.mode)) {
      issues.push(`Consult smoke test returned an invalid mode: ${consultCheck.mode}`);
    }
    if (consultCheck.researchDecision.needsWebResearch !== true) {
      issues.push('Consult smoke test did not recommend web research for a current auth best-practice query.');
    }
    if (!consultCheck.trustSummary || !Array.isArray(consultCheck.evidence?.topResults)) {
      issues.push('Consult smoke test returned without provenance-aware trust summary fields.');
    }

    retrievalDiagnostics = await buildDoctorRetrievalDiagnostics(config, state, options, embedderSelection);
    const weakestCurrentProjectRecall = [...(retrievalDiagnostics?.projects ?? [])]
      .sort((left, right) => left.currentProjectPrecisionAt3 - right.currentProjectPrecisionAt3)[0];
    if (weakestCurrentProjectRecall && weakestCurrentProjectRecall.currentProjectPrecisionAt3 < 0.5) {
      warnings.push(`Doctor retrieval diagnostics: ${weakestCurrentProjectRecall.project} recalled current-project evidence in only ${Math.round(weakestCurrentProjectRecall.currentProjectPrecisionAt3 * 100)}% of diagnostic queries.`);
    }
    const weakestCitationCoverage = [...(retrievalDiagnostics?.projects ?? [])]
      .sort((left, right) => left.citationCoverage - right.citationCoverage)[0];
    if (weakestCitationCoverage && weakestCitationCoverage.citationCoverage < 0.67) {
      warnings.push(`Doctor retrieval diagnostics: ${weakestCitationCoverage.project} returned thin supporting citations in top results.`);
    }
    if ((retrievalDiagnostics?.averageLatencyMs ?? 0) > 2500) {
      warnings.push(`Doctor retrieval diagnostics: average search latency is elevated at ${retrievalDiagnostics.averageLatencyMs}ms.`);
    }
    if ((queryCheckLatencyMs ?? 0) > 2500 && embedderPrewarm.outcome === 'ready') {
      warnings.push(`Doctor query smoke latency is still elevated at ${queryCheckLatencyMs}ms even after successful embedder prewarm.`);
    }
    if ((consultCheckLatencyMs ?? 0) > 5000) {
      warnings.push(`Doctor consultation diagnostics: consult latency is elevated at ${consultCheckLatencyMs}ms.`);
    }
  }

  let mcpHealth = { ok: false, tools: [], stdout: '', error: null, durationMs: null };
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
    const mcpHealthStartedAt = Date.now();
    const { stdout } = await execFileAsync(process.execPath, healthcheckArgs, {
      cwd: config.brainRoot,
      env: process.env,
      timeout: 30000,
    });
    const durationMs = Date.now() - mcpHealthStartedAt;
    const toolsLine = String(stdout ?? '').split('\n').find((line) => line.startsWith('Tools:')) ?? '';
    const tools = toolsLine.replace(/^Tools:\s*/, '').split(',').map((item) => item.trim()).filter(Boolean);
    mcpHealth = { ok: true, tools, stdout: String(stdout ?? '').trim(), error: null, durationMs };
  } catch (error) {
    mcpHealth = { ok: false, tools: [], stdout: '', error: error.message, durationMs: null };
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
    embedderPrewarm,
    embedderRunner: buildEmbedderRunnerReport(config, embedderSelection, queryCheck?.embedderRuntime ?? consultCheck?.embedderRuntime ?? null),
    queryCheck: queryCheck ? {
      resultCount: queryCheck.results.length,
      topNoteTypes: queryCheck.results.slice(0, 5).map((result) => result.noteType),
      latencyMs: queryCheckLatencyMs,
      embedderRuntime: queryCheck.embedderRuntime ?? null,
    } : null,
    consultCheck: consultCheck ? {
      mode: consultCheck.mode,
      needsWebResearch: consultCheck.researchDecision.needsWebResearch,
      decisionScore: consultCheck.decisionTrace?.score ?? null,
      latencyMs: consultCheckLatencyMs,
      embedderRuntime: consultCheck.embedderRuntime ?? null,
    } : null,
    retrievalDiagnostics,
    memoryAdmission: summarizeMemoryAdmission(state, config),
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

async function loadManagedKnowledgeProjects(config, state, preferredProjects = []) {
  const cachedProjects = await listCachedProjectSnapshots(config, Object.keys(state.projects ?? {}));
  const projectsByName = new Map(cachedProjects.map((project) => [project.name, project]));
  for (const project of preferredProjects.filter(Boolean)) {
    projectsByName.set(project.name, project);
  }
  return [...projectsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function syncGlobalKnowledgeEmbeddings(config, embedder, vectorStore) {
  const noteContents = await readGlobalKnowledgeNoteContents(config);
  const sources = buildGlobalKnowledgeSources(noteContents);
  const previousChunks = await loadProjectChunks(config, GLOBAL_KNOWLEDGE_CACHE_KEY);
  const previousIds = new Set(previousChunks.map((chunk) => chunk.id));

  if (sources.length === 0) {
    if (previousIds.size > 0) {
      await vectorStore.deleteIds([...previousIds]);
      await cacheProjectChunks(config, GLOBAL_KNOWLEDGE_CACHE_KEY, []);
    }
    return { chunkCount: 0 };
  }

  const fingerprint = sha256(Object.values(noteContents)
    .filter(Boolean)
    .map((payload) => `${payload.sourcePath}:${payload.text}`)
    .join('\n\n'));
  const knowledgeProject = {
    name: GLOBAL_KNOWLEDGE_PROJECT_NAME,
    fingerprint,
    normalizedAt: timestamp(),
    rootPath: config.vaultRoot,
    tags: ['knowledge', 'global'],
  };
  const chunks = chunkProjectKnowledge(knowledgeProject, sources);
  const nextIds = new Set(chunks.map((chunk) => chunk.id));
  const deletedIds = [...previousIds].filter((id) => !nextIds.has(id));
  if (deletedIds.length > 0) {
    await vectorStore.deleteIds(deletedIds);
  }

  const embeddings = await embedder.embedTexts(chunks.map((chunk) => chunk.content));
  await vectorStore.upsert(chunks, embeddings);
  await cacheProjectChunks(config, GLOBAL_KNOWLEDGE_CACHE_KEY, chunks);
  return { chunkCount: chunks.length };
}

function startEmbedderPrewarm(config, context) {
  const plan = resolveEmbedderPrewarmPlan(config, context);
  if (!plan.enabled) {
    return {
      plan,
      promise: Promise.resolve(buildSkippedEmbedderPrewarm(config, context, plan.skipReason)),
    };
  }

  return {
    plan,
    promise: prewarmEmbeddingService({
      pythonExecutable: config.pythonExecutable,
      timeoutMs: config.embedderPrewarmTimeoutMs,
      reason: context,
      strategy: plan.strategy,
    }),
  };
}

function startCommandEmbedderPrewarm(config, context, embedderSelection) {
  if (embedderSelection?.backend === 'runner') {
    return {
      plan: {
        enabled: false,
        strategy: 'skipped',
        skipReason: 'persistent runner in use',
      },
      promise: Promise.resolve(buildSkippedEmbedderPrewarm(config, context, 'persistent runner in use')),
    };
  }
  return startEmbedderPrewarm(config, context);
}

function resolveEmbedderPrewarmPlan(config, context) {
  const configuredMode = String(config.embedderPrewarm ?? 'auto').trim().toLowerCase();
  if (['off', 'false', 'disabled', 'none'].includes(configuredMode)) {
    return { enabled: false, strategy: 'skipped', skipReason: 'disabled by configuration' };
  }
  if (configuredMode === 'blocking') {
    return { enabled: true, strategy: 'blocking' };
  }
  if (configuredMode === 'background') {
    return { enabled: true, strategy: 'background' };
  }
  if (context === 'doctor' || context === 'mcp-startup') {
    return { enabled: true, strategy: 'blocking' };
  }
  if (context === 'embed' || context === 'query' || context === 'consult') {
    return { enabled: true, strategy: 'background' };
  }
  return { enabled: false, strategy: 'skipped', skipReason: `${context} does not use embeddings` };
}

function buildSkippedEmbedderPrewarm(config, context, skipReason) {
  return {
    at: timestamp(),
    outcome: 'skipped',
    reason: context,
    strategy: 'skipped',
    timeoutMs: config.embedderPrewarmTimeoutMs,
    durationMs: 0,
    servicePid: null,
    pythonExecutable: config.pythonExecutable,
    error: skipReason,
  };
}

function recordEmbedderPrewarmOperation(state, embedderPrewarm) {
  if (!embedderPrewarm || embedderPrewarm.outcome === 'skipped') {
    return;
  }
  recordOperation(state, 'embedder-prewarm', {
    outcome: embedderPrewarm.outcome,
    reason: embedderPrewarm.reason,
    strategy: embedderPrewarm.strategy,
    durationMs: embedderPrewarm.durationMs,
    timeoutMs: embedderPrewarm.timeoutMs,
    servicePid: embedderPrewarm.servicePid,
    pythonExecutable: embedderPrewarm.pythonExecutable,
    error: embedderPrewarm.error,
    summary: `Embedder prewarm ${embedderPrewarm.outcome} for ${embedderPrewarm.reason} (${embedderPrewarm.durationMs}ms)`,
  });
}

function summarizeEmbedderPrewarmState(state, config) {
  const latest = getLatestOperation(state, ['embedder-prewarm']);
  return {
    configuredMode: config.embedderPrewarm,
    timeoutMs: config.embedderPrewarmTimeoutMs,
    latest: latest ? {
      at: latest.at,
      outcome: latest.outcome ?? 'unknown',
      reason: latest.reason ?? 'unknown',
      strategy: latest.strategy ?? 'unknown',
      durationMs: latest.durationMs ?? null,
      timeoutMs: latest.timeoutMs ?? config.embedderPrewarmTimeoutMs,
      servicePid: latest.servicePid ?? null,
      pythonExecutable: latest.pythonExecutable ?? null,
      error: latest.error ?? null,
    } : null,
  };
}

function buildEmbedderRunnerReport(config, selection, embedderRuntime = null) {
  const runnerStatus = selection?.runnerStatus ?? {
    mode: config.embedderRunnerMode,
    running: false,
    healthy: false,
    stale: false,
    staleReasons: [],
    pid: null,
    socketPath: config.embedderRunnerSocketPath,
    statePath: config.embedderRunnerStatePath,
    lockPath: config.embedderRunnerLockPath,
    model: null,
    dimensions: null,
    startedAt: null,
    lastUsedAt: null,
    uptimeMs: null,
    idleTimeoutMs: config.embedderRunnerIdleTimeoutMs,
    requestTimeoutMs: config.embedderRunnerRequestTimeoutMs,
    lastError: null,
    backendIfQueriedNow: 'in-process',
  };
  return {
    ...runnerStatus,
    selectedBackend: embedderRuntime?.backend ?? selection?.backend ?? runnerStatus.backendIfQueriedNow,
    usedByCommand: Boolean(embedderRuntime?.usedRunner ?? selection?.usedRunner),
    startupAction: selection?.startup?.action ?? null,
    startupDurationMs: selection?.startup?.durationMs ?? 0,
    fallbackReason: embedderRuntime?.fallbackReason ?? selection?.fallbackReason ?? null,
  };
}

const DIAGNOSTIC_QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'when', 'where', 'which',
  'project', 'repo', 'current', 'use', 'uses', 'used', 'keep', 'should', 'instead', 'package',
  'script', 'node', 'run', 'docs', 'guide', 'guidance', 'note', 'notes', 'local', 'brain',
]);

async function buildDoctorRetrievalDiagnostics(config, state, options = {}, embedderSelection = null) {
  const snapshots = await listCachedProjectSnapshots(config, Object.keys(state.projects ?? {}));
  const diagnosticProjects = prioritizeDoctorProjects(snapshots, state).slice(0, 2);
  const projectReports = [];

  for (const project of diagnosticProjects) {
    const queries = buildProjectDiagnosticQueries(project).slice(0, snapshots.length === 1 ? 2 : 1);
    if (queries.length === 0) {
      continue;
    }

    const queryReports = [];
    for (const query of queries) {
      const startedAt = Date.now();
      const payload = await searchBrain({
        query,
        currentProjectName: project.name,
        topK: 4,
        runtimeOptions: options,
        recordUsage: false,
        includeRelatedPatterns: false,
        includeRecentLearnings: false,
        embedderSelection,
      });
      queryReports.push(summarizeDoctorSearch({
        query,
        payload,
        currentProjectName: project.name,
        latencyMs: Date.now() - startedAt,
      }));
    }

    projectReports.push(summarizeDoctorProjectDiagnostics(project.name, queryReports));
  }

  return {
    averageLatencyMs: averageNumbers(projectReports.map((project) => project.averageLatencyMs)),
    weakestProject: [...projectReports]
      .sort((left, right) => left.currentProjectPrecisionAt3 - right.currentProjectPrecisionAt3 || left.citationCoverage - right.citationCoverage)[0]?.project ?? null,
    projects: projectReports,
  };
}

function prioritizeDoctorProjects(snapshots, state) {
  return [...snapshots].sort((left, right) => {
    const brainPriority = Number(right.name === 'brain') - Number(left.name === 'brain');
    if (brainPriority !== 0) {
      return brainPriority;
    }
    const chunkDelta = Number(state.projects?.[right.name]?.chunkCount ?? 0) - Number(state.projects?.[left.name]?.chunkCount ?? 0);
    if (chunkDelta !== 0) {
      return chunkDelta;
    }
    return left.name.localeCompare(right.name);
  });
}

function buildProjectDiagnosticQueries(project) {
  const candidates = [
    buildDiagnosticQuery(project.name, project.provenance?.boundaryRules?.[0]?.value ?? project.boundaryRules?.[0], 'safe change boundary'),
    buildDiagnosticQuery(project.name, project.provenance?.validationSurfaces?.[0]?.value ?? project.validationSurfaces?.[0], 'validation surface'),
    buildDiagnosticQuery(project.name, project.provenance?.reusableSolutions?.[0]?.value ?? project.reusableSolutions?.[0], 'reusable pattern'),
  ];
  return [...new Set(candidates.filter(Boolean))];
}

function buildDiagnosticQuery(projectName, seedText, fallbackPhrase) {
  const keywords = extractDiagnosticKeywords(seedText).slice(0, 6).join(' ');
  const suffix = keywords || fallbackPhrase;
  return suffix ? `${projectName} ${suffix}`.trim() : String(projectName ?? '').trim();
}

function extractDiagnosticKeywords(seedText) {
  return tokenize(String(seedText ?? ''))
    .filter((token) => token.length >= 4)
    .filter((token) => !DIAGNOSTIC_QUERY_STOPWORDS.has(token))
    .slice(0, 8);
}

function summarizeDoctorSearch({ query, payload, currentProjectName, latencyMs }) {
  const topResults = (payload?.results ?? []).slice(0, 3);
  const currentProjectHits = topResults.filter((result) => result.project === currentProjectName);
  const citationCoverage = topResults.length > 0
    ? topResults.filter((result) => (result.supportingSources?.length ?? 0) > 0).length / topResults.length
    : 0;
  const strongEvidenceRatio = topResults.length > 0
    ? topResults.filter((result) => result.evidenceQuality === 'strong').length / topResults.length
    : 0;
  const averageConfidence = averageNumbers(topResults.map((result) => Number(result.confidence ?? 0)));
  const issues = [];

  if (currentProjectHits.length === 0) {
    issues.push('no current-project evidence in top results');
  }
  if (citationCoverage < 0.67) {
    issues.push('supporting citations are thin');
  }
  if (strongEvidenceRatio === 0) {
    issues.push('top matches are not strongly evidenced');
  }
  if (latencyMs > 2000) {
    issues.push('search latency is elevated');
  }

  return {
    query,
    resultCount: payload?.results?.length ?? 0,
    currentProjectTop1: Boolean(topResults[0] && topResults[0].project === currentProjectName),
    currentProjectPrecisionAt3: Number((currentProjectHits.length / Math.max(topResults.length, 1)).toFixed(2)),
    citationCoverage: Number(citationCoverage.toFixed(2)),
    strongEvidenceRatio: Number(strongEvidenceRatio.toFixed(2)),
    averageConfidence,
    latencyMs,
    topResult: topResults[0]
      ? {
        project: topResults[0].project,
        noteType: topResults[0].noteType,
        evidenceQuality: topResults[0].evidenceQuality,
        relevanceScore: topResults[0].relevanceScore,
      }
      : null,
    issues,
  };
}

function summarizeDoctorProjectDiagnostics(projectName, queryReports) {
  return {
    project: projectName,
    averageLatencyMs: averageNumbers(queryReports.map((report) => report.latencyMs)),
    currentProjectTop1Rate: averageNumbers(queryReports.map((report) => (report.currentProjectTop1 ? 1 : 0))),
    currentProjectPrecisionAt3: averageNumbers(queryReports.map((report) => report.currentProjectPrecisionAt3)),
    citationCoverage: averageNumbers(queryReports.map((report) => report.citationCoverage)),
    strongEvidenceRatio: averageNumbers(queryReports.map((report) => report.strongEvidenceRatio)),
    averageConfidence: averageNumbers(queryReports.map((report) => report.averageConfidence)),
    issues: [...new Set(queryReports.flatMap((report) => report.issues))],
    queries: queryReports,
  };
}

function averageNumbers(values = []) {
  const numericValues = values.filter((value) => Number.isFinite(Number(value))).map((value) => Number(value));
  if (numericValues.length === 0) {
    return 0;
  }
  return Number((numericValues.reduce((total, value) => total + value, 0) / numericValues.length).toFixed(2));
}
