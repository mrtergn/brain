import fs from 'node:fs/promises';
import path from 'node:path';

import { LocalSemanticEmbedder } from '../embeddings/index.mjs';
import { readProjectNoteContents, writeQueryHistoryNote as writeCanonicalQueryHistoryNote } from '../obsidian-writer/index.mjs';
import {
  maxEvidenceConfidence,
  maxEvidenceQuality,
  pickTopEvidenceItems,
  summarizeEvidenceSource,
} from '../provenance/index.mjs';
import { reasonAboutQuery } from '../reasoner/index.mjs';
import { buildResearchConsultation, synthesizeLocalAndExternalGuidance } from '../research/index.mjs';
import { expandQueryText, retrieveContext } from '../retriever/index.mjs';
import {
  appendLog,
  buildLogPath,
  buildRuntimeConfig,
  ensureDir,
  exists,
  normalizeSlashes,
  readText,
  timestamp,
  uniqueStrings,
  writeText,
} from '../shared/index.mjs';
import {
  loadCachedProjectSnapshot,
  loadState,
  listCachedProjectSnapshots,
  recordQuery,
  recordOperation,
  saveState,
} from '../state-manager/index.mjs';
import { stripLegacyManagedSections } from '../vault-contract/index.mjs';
import { ChromaVectorStore } from '../vector-store/index.mjs';

const AI_GENERATED_START = '<!-- AI_BRAIN:GENERATED_START -->';
const AI_GENERATED_END = '<!-- AI_BRAIN:GENERATED_END -->';
const BRAIN_GENERATED_START = '<!-- BRAIN:GENERATED_START -->';
const BRAIN_GENERATED_END = '<!-- BRAIN:GENERATED_END -->';

const RESEARCH_CANDIDATES_TEMPLATE = [
  '# Research Candidates',
  '',
  'Store promising external findings here only when they are concrete, implementation-relevant, and not yet proven enough for permanent memory.',
  '',
  '## Promotion Rules',
  '- Promote to project learnings only after implementation proves the finding useful in a specific repo.',
  '- Promote to reusable-patterns only after the pattern is clearly cross-project and high-signal.',
  '- Prefer Tier 1 official sources. Tier 2 authoritative references are acceptable when official docs are incomplete. Tier 3 community sources should stay clearly marked and provisional.',
  '',
  '## Memory Hygiene',
  '- Do not treat this note as part of the permanent semantic core by default.',
  '- Use research candidates to prevent the vault from turning into a web clipping dump.',
].join('\n');

export async function searchBrain({ query, currentProjectPath, currentProjectName, topK = 6, runtimeOptions } = {}) {
  const {
    readyRuntime,
    resolvedProject,
    retrievalResponse,
    reasoning,
    relatedPatterns,
    recentLearnings,
  } = await gatherLocalBrainContext({
    query,
    currentProjectPath,
    currentProjectName,
    topK,
    runtimeOptions,
    includeProjectSummary: false,
    recentLearningsLimit: 4,
  });

  recordQuery(readyRuntime.state, {
    at: timestamp(),
    query: String(query ?? '').trim(),
    mode: reasoning.mode,
    relatedProjects: reasoning.relatedProjects,
    topResultIds: retrievalResponse.results.slice(0, 5).map((result) => `${result.project}:${result.noteType}:${result.sourcePath}`),
  });
  recordOperation(readyRuntime.state, 'query', {
    projects: reasoning.relatedProjects,
    summary: `MCP query '${String(query ?? '').trim()}' matched ${reasoning.relatedProjects.join(', ') || 'no projects'}`,
  });
  await saveState(readyRuntime.config, readyRuntime.state);
  readyRuntime.state = await loadState(readyRuntime.config);
  await refreshQueryHistoryNote(readyRuntime.config, readyRuntime.state);

  await appendLog(buildLogPath(readyRuntime.config, 'brain-mcp.log'), `brain.search | query=${JSON.stringify(query)} | project=${resolvedProject?.name ?? 'global'}`);

  return {
    query: String(query ?? '').trim(),
    expandedQuery: retrievalResponse.expandedQueryText,
    expansionTerms: retrievalResponse.expansionTerms,
    currentProjectName: resolvedProject?.name ?? null,
    currentProjectPath: resolvedProject?.rootPath ?? null,
    results: retrievalResponse.results.map((result) => ({
      project: result.project,
      noteType: result.noteType,
      sourcePath: result.sourcePath,
      sourceKind: result.sourceKind,
      relevanceScore: result.relevanceScore,
      whyMatched: result.whyMatched,
      whyTrusted: result.whyTrusted,
      knowledgeType: result.knowledgeType,
      knowledgeStrength: result.knowledgeStrength,
      evidenceQuality: result.evidenceQuality,
      confidence: result.confidence,
      supportCount: result.supportCount,
      supportingSources: result.supportingSources ?? [],
      derivedFrom: result.derivedFrom ?? [],
      evidenceSummary: result.evidenceSummary ?? '',
      snippet: result.snippet,
      matchedTerms: result.matchedTerms ?? [],
    })),
    reasoning: {
      relatedProjects: reasoning.relatedProjects,
      solutionSuggestions: reasoning.solutionSuggestions,
      improvementRecommendations: reasoning.improvementRecommendations,
    },
    relatedPatterns,
    recentLearnings,
  };
}

export async function consultBrain({ query, currentProjectPath, currentProjectName, topK = 6, runtimeOptions } = {}) {
  const {
    readyRuntime,
    resolvedProject,
    retrievalResponse,
    reasoning,
    relatedPatterns,
    recentLearnings,
    projectSummary,
  } = await gatherLocalBrainContext({
    query,
    currentProjectPath,
    currentProjectName,
    topK,
    runtimeOptions,
    includeProjectSummary: true,
    recentLearningsLimit: 4,
  });

  const payload = buildResearchConsultation({
    query,
    currentProjectName: resolvedProject?.name ?? null,
    currentProjectPath: resolvedProject?.rootPath ?? null,
    retrievalResponse,
    reasoning,
    projectSummary,
    relatedPatterns,
    recentLearnings,
  });

  recordQuery(readyRuntime.state, {
    at: timestamp(),
    query: String(query ?? '').trim(),
    mode: payload.mode,
    relatedProjects: payload.localContext.relatedProjects,
    topResultIds: retrievalResponse.results.slice(0, 5).map((result) => `${result.project}:${result.noteType}:${result.sourcePath}`),
    webResearchRecommended: payload.researchDecision.needsWebResearch,
    localConfidence: payload.localConfidence.score,
  });
  recordOperation(readyRuntime.state, 'consult', {
    projects: payload.localContext.relatedProjects,
    summary: `Consult '${String(query ?? '').trim()}' -> ${payload.mode}`,
  });
  await saveState(readyRuntime.config, readyRuntime.state);
  readyRuntime.state = await loadState(readyRuntime.config);
  await refreshQueryHistoryNote(readyRuntime.config, readyRuntime.state);

  await appendLog(buildLogPath(readyRuntime.config, 'brain-mcp.log'), `brain.consult | query=${JSON.stringify(query)} | project=${resolvedProject?.name ?? 'global'} | mode=${payload.mode}`);
  return payload;
}

export async function synthesizeGuidance({
  query,
  externalFindings,
  currentProjectPath,
  currentProjectName,
  topK = 6,
  runtimeOptions,
} = {}) {
  const {
    readyRuntime,
    resolvedProject,
    retrievalResponse,
    reasoning,
    relatedPatterns,
    recentLearnings,
    projectSummary,
  } = await gatherLocalBrainContext({
    query,
    currentProjectPath,
    currentProjectName,
    topK,
    runtimeOptions,
    includeProjectSummary: true,
    recentLearningsLimit: 4,
  });

  const consultation = buildResearchConsultation({
    query,
    currentProjectName: resolvedProject?.name ?? null,
    currentProjectPath: resolvedProject?.rootPath ?? null,
    retrievalResponse,
    reasoning,
    projectSummary,
    relatedPatterns,
    recentLearnings,
  });
  const payload = synthesizeLocalAndExternalGuidance({
    consultation,
    externalFindings,
    noteTargets: buildResearchNoteTargets(readyRuntime.config, resolvedProject?.name ?? null),
  });

  recordOperation(readyRuntime.state, 'synthesize-guidance', {
    projects: consultation.localContext.relatedProjects,
    summary: `Synthesized local and external guidance for '${String(query ?? '').trim()}'`,
  });
  await saveState(readyRuntime.config, readyRuntime.state);
  await appendLog(buildLogPath(readyRuntime.config, 'brain-mcp.log'), `brain.synthesize_guidance | query=${JSON.stringify(query)} | project=${resolvedProject?.name ?? 'global'}`);
  return payload;
}

export async function getProjectSummary({ projectPath, projectName, runtimeOptions } = {}) {
  const runtime = await loadBrainRuntime(runtimeOptions);
  const readyRuntime = await ensureKnowledgeReady(runtime, { skipEmbed: true });
  const resolvedProject = await resolveProjectContext(readyRuntime, {
    projectPath,
    projectName,
  });

  if (!resolvedProject) {
    throw new Error('Project could not be resolved from the provided path or name.');
  }

  await appendLog(buildLogPath(readyRuntime.config, 'brain-mcp.log'), `brain.project_summary | project=${resolvedProject.name}`);

  return buildProjectSummaryPayload(readyRuntime, resolvedProject);
}

export async function getRelatedPatterns({ query, currentProjectName, topK = 5, runtimeOptions } = {}) {
  const runtime = await loadBrainRuntime(runtimeOptions);
  const readyRuntime = await ensureKnowledgeReady(runtime, { skipEmbed: true });
  const patterns = await getRelatedPatternsInternal(readyRuntime, {
    query,
    currentProjectName,
    topK,
  });

  await appendLog(buildLogPath(readyRuntime.config, 'brain-mcp.log'), `brain.related_patterns | query=${JSON.stringify(query)} | project=${currentProjectName ?? 'global'}`);

  return {
    query: String(query ?? '').trim(),
    currentProjectName: currentProjectName ?? null,
    patterns,
  };
}

export async function getRecentLearnings({ currentProjectName, category, limit = 6, runtimeOptions } = {}) {
  const runtime = await loadBrainRuntime(runtimeOptions);
  const readyRuntime = await ensureKnowledgeReady(runtime, { skipEmbed: true });
  const response = await getRecentLearningsInternal(readyRuntime, {
    currentProjectName,
    category,
    limit,
  });

  await appendLog(buildLogPath(readyRuntime.config, 'brain-mcp.log'), `brain.recent_learnings | project=${currentProjectName ?? 'global'} | category=${category ?? 'all'}`);

  return {
    currentProjectName: currentProjectName ?? null,
    category: category ?? 'all',
    items: response,
  };
}

export async function captureLearning({
  title,
  projectName,
  problem,
  context,
  solution,
  whyItWorked,
  reusablePattern,
  tags = [],
  runtimeOptions,
} = {}) {
  validateCapturedLearningInput({ title, problem, context, solution, whyItWorked, reusablePattern });

  const runtime = await loadBrainRuntime(runtimeOptions);
  let readyRuntime = await ensureKnowledgeReady(runtime, { skipEmbed: true });
  let workerModule = null;

  let resolvedProject = await resolveProjectContext(readyRuntime, { projectName });
  if (!resolvedProject && projectName) {
    const projectRootCandidate = path.join(readyRuntime.config.projectsRoot, projectName);
    if (await exists(projectRootCandidate)) {
      workerModule = workerModule ?? await import('../../apps/worker/index.mjs');
      await workerModule.runSync({ ...(runtimeOptions ?? {}), projectNames: [projectName] });
      readyRuntime = await loadBrainRuntime(runtimeOptions);
      resolvedProject = await resolveProjectContext(readyRuntime, { projectName });
    }
  }

  const targetProjectName = resolvedProject?.name ?? String(projectName ?? '').trim();
  if (!targetProjectName) {
    throw new Error('project_name is required to capture a learning.');
  }

  const learningsPath = path.join(readyRuntime.config.vaultRoot, '01_Projects', targetProjectName, 'learnings.md');
  await ensureDir(path.dirname(learningsPath));
  const existing = await readText(learningsPath, '');
  const normalized = normalizeLearningNote(existing, targetProjectName);
  const entry = buildCapturedLearningEntry({
    index: nextLearningIndex(normalized),
    title,
    projectName: targetProjectName,
    problem,
    context,
    solution,
    whyItWorked,
    reusablePattern,
    tags,
  });
  await writeText(learningsPath, appendCanonicalEntry(normalized, entry));

  const state = await loadState(readyRuntime.config);
  recordOperation(state, 'capture-learning', {
    projects: [targetProjectName],
    summary: `Captured learning for ${targetProjectName}: ${title ?? 'untitled learning'}`,
  });
  await saveState(readyRuntime.config, state);
  await appendLog(buildLogPath(readyRuntime.config, 'brain-mcp.log'), `brain.capture_learning | project=${targetProjectName} | title=${JSON.stringify(title ?? '')}`);

  if (resolvedProject) {
    workerModule = workerModule ?? await import('../../apps/worker/index.mjs');
    await workerModule.runEmbed({ ...(runtimeOptions ?? {}), projectNames: [targetProjectName], force: true });
  }

  return {
    projectName: targetProjectName,
    notePath: learningsPath,
    embedded: Boolean(resolvedProject),
    capturedAt: timestamp(),
  };
}

export async function captureResearchCandidate({
  title,
  query,
  finding,
  recommendation,
  whyItMatters,
  reusePotential,
  sourceQuality,
  sources = [],
  projectName,
  promotionCriteria,
  tags = [],
  runtimeOptions,
} = {}) {
  validateResearchCandidateInput({ title, query, finding, recommendation, whyItMatters, reusePotential, sourceQuality });

  const runtime = await loadBrainRuntime(runtimeOptions);
  const notePath = path.join(runtime.config.vaultRoot, '03_Agent_Notes', 'research-candidates.md');
  await ensureDir(path.dirname(notePath));
  const existing = await readText(notePath, '');
  const normalized = normalizeResearchCandidatesNote(existing);
  const entry = buildResearchCandidateEntry({
    title,
    query,
    finding,
    recommendation,
    whyItMatters,
    reusePotential,
    sourceQuality,
    sources,
    projectName,
    promotionCriteria,
    tags,
  });
  await writeText(notePath, appendCanonicalEntry(normalized, entry));

  recordOperation(runtime.state, 'capture-research-candidate', {
    projects: projectName ? [projectName] : [],
    summary: `Captured research candidate: ${title ?? 'untitled research candidate'}`,
  });
  await saveState(runtime.config, runtime.state);
  await appendLog(buildLogPath(runtime.config, 'brain-mcp.log'), `brain.capture_research_candidate | title=${JSON.stringify(title ?? '')} | project=${projectName ?? 'global'}`);

  return {
    notePath,
    projectName: projectName ?? null,
    embedded: false,
    capturedAt: timestamp(),
  };
}

async function loadBrainRuntime(runtimeOptions = {}) {
  const config = buildRuntimeConfig(runtimeOptions);
  const state = await loadState(config);
  const snapshots = await listCachedProjectSnapshots(config, Object.keys(state.projects));
  return {
    config,
    state,
    snapshots,
  };
}

async function ensureKnowledgeReady(runtime, { skipEmbed = false } = {}) {
  if (runtime.snapshots.length > 0 && (skipEmbed || runtime.state.lastEmbedAt)) {
    return runtime;
  }

  await runSync({});
  if (!skipEmbed) {
    await runEmbed({});
  }
  return loadBrainRuntime();
}

async function resolveProjectContext(runtime, { projectPath, projectName } = {}) {
  if (!projectPath && !projectName) {
    return null;
  }

  const byName = projectName
    ? runtime.snapshots.find((project) => project.name.toLowerCase() === String(projectName).trim().toLowerCase())
    : null;
  if (byName) {
    return byName;
  }

  if (!projectPath) {
    return null;
  }

  const resolvedPath = path.resolve(String(projectPath));
  const pathMatch = [...runtime.snapshots]
    .filter((project) => resolvedPath === path.resolve(project.rootPath) || resolvedPath.startsWith(`${path.resolve(project.rootPath)}${path.sep}`))
    .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
  if (pathMatch) {
    return pathMatch;
  }

  const normalizedProjectsRoot = `${path.resolve(runtime.config.projectsRoot)}${path.sep}`;
  if (resolvedPath.startsWith(normalizedProjectsRoot)) {
    const relativePath = normalizeSlashes(path.relative(runtime.config.projectsRoot, resolvedPath));
    const firstSegment = relativePath.split('/')[0];
    if (firstSegment) {
      return runtime.snapshots.find((project) => project.name === firstSegment) ?? (await loadCachedProjectSnapshot(runtime.config, firstSegment));
    }
  }

  return null;
}

async function getRelatedPatternsInternal(runtime, { query, currentProjectName, topK = 5 } = {}) {
  const { expansionTerms } = expandQueryText(String(query ?? '').trim());
  const queryTokens = new Set(uniqueStrings([
    ...tokenizeQuery(String(query ?? '')),
    ...expansionTerms.flatMap((term) => tokenizeQuery(term)),
  ]));
  const documentationQuery = [...queryTokens].some((token) => ['readme', 'docs', 'documentation', 'architecture', 'guide', 'guidance', 'agent', 'copilot', 'github', 'onboarding'].includes(token));
  const catalog = buildPatternCatalog(runtime.snapshots);

  const scored = catalog.map((pattern) => {
    const patternTokens = new Set(tokenizeQuery(`${pattern.pattern} ${pattern.explanation}`));
    let matches = 0;
    for (const token of queryTokens) {
      if (patternTokens.has(token)) {
        matches += 1;
      }
    }
    const lexicalScore = queryTokens.size > 0 ? matches / queryTokens.size : 0;
    const currentProjectBoost = currentProjectName && pattern.sourceProjects.includes(currentProjectName) ? 0.15 : 0;
    const repeatedUseBoost = Math.min(pattern.sourceProjects.length * 0.04, 0.16);
    const documentationBoost = documentationQuery && isDocumentationPattern(pattern.pattern) ? 0.14 : 0;
    const evidenceBoost = pattern.evidenceQuality === 'strong' ? 0.12 : (pattern.evidenceQuality === 'medium' ? 0.06 : 0);
    const confidenceBoost = Math.min(Number(pattern.confidence ?? 0) * 0.08, 0.08);
    const relevanceScore = Number(Math.min(1, lexicalScore + currentProjectBoost + repeatedUseBoost + documentationBoost + evidenceBoost + confidenceBoost).toFixed(4));
    return {
      patternTitle: pattern.pattern,
      explanation: pattern.explanation,
      sourceProjects: pattern.sourceProjects,
      whereUsedBefore: pattern.whereUsedBefore.length > 0
        ? pattern.whereUsedBefore
        : pattern.sourceProjects.map((projectName) => buildProjectNoteReferences(runtime.config, projectName).learnings),
      supportingEvidence: pattern.supportingEvidence.slice(0, 4),
      evidenceQuality: pattern.evidenceQuality,
      confidence: pattern.confidence,
      supportCount: pattern.supportCount,
      whyTrusted: buildPatternTrustSummary(pattern),
      relevanceScore,
    };
  });

  const sorted = scored
    .sort((left, right) => right.relevanceScore - left.relevanceScore || right.sourceProjects.length - left.sourceProjects.length)
    .filter((pattern, index) => pattern.relevanceScore > 0 || index < topK)
    .slice(0, topK);

  return sorted;
}

async function getRecentLearningsInternal(runtime, { currentProjectName, category, limit = 6 } = {}) {
  const items = [];
  const categoryValue = String(category ?? 'all').toLowerCase();

  if (!category || categoryValue === 'all' || categoryValue === 'learning' || categoryValue === 'project') {
    const orderedProjects = [...runtime.snapshots].sort((left, right) => {
      const leftAt = runtime.state.projects?.[left.name]?.lastSyncedAt ?? '';
      const rightAt = runtime.state.projects?.[right.name]?.lastSyncedAt ?? '';
      return rightAt.localeCompare(leftAt);
    });

    const prioritized = currentProjectName
      ? orderedProjects.sort((left, right) => Number(right.name === currentProjectName) - Number(left.name === currentProjectName))
      : orderedProjects;

    for (const project of prioritized.slice(0, limit)) {
      const learningsPath = buildProjectNoteReferences(runtime.config, project.name).learnings;
      const learningsText = await readText(learningsPath, '');
      const summary = summarizeLearningNote(learningsText, project);
      if (!summary.strong) {
        continue;
      }
      items.push({
        type: 'project-learning',
        projectName: project.name,
        title: `${project.name}: ${summary.problem}`,
        excerpt: summary.reusablePattern[0] ?? summary.solution[0] ?? summary.problem,
        notePath: learningsPath,
        evidenceQuality: summary.evidenceQuality ?? 'weak',
        confidence: summary.confidence ?? 0,
        supportingSources: summary.supportingSources ?? [],
        updatedAt: runtime.state.projects?.[project.name]?.lastSyncedAt ?? null,
      });
    }
  }

  if (!category || categoryValue === 'all' || categoryValue === 'debug' || categoryValue === 'debugging') {
    const debuggingInsightsPath = path.join(runtime.config.vaultRoot, '03_Agent_Notes', 'debugging-insights.md');
    const debuggingText = await readText(debuggingInsightsPath, '');
    const sections = parseMarkdownSections(debuggingText);
    const debugBullets = [
      ...extractBulletLines(sections['Current Insights'] ?? ''),
      ...extractBulletLines(sections['What repeatedly helps'] ?? ''),
      ...extractBulletLines(sections['Operational lessons worth keeping'] ?? ''),
    ].slice(0, 4);
    for (const bullet of debugBullets) {
      items.push({
        type: 'debugging-insight',
        projectName: currentProjectName ?? null,
        title: 'Debugging insight',
        excerpt: bullet,
        notePath: debuggingInsightsPath,
        evidenceQuality: 'medium',
        confidence: 0.64,
        supportingSources: [{
          sourcePath: debuggingInsightsPath,
          sourceKind: 'note',
          sourceSection: 'debugging-insights',
          excerpt: bullet,
        }],
        updatedAt: await safeFileTimestamp(debuggingInsightsPath),
      });
    }
  }

  if (!category || categoryValue === 'all' || categoryValue === 'pattern') {
    const patterns = await getRelatedPatternsInternal(runtime, {
      query: 'reusable pattern',
      currentProjectName,
      topK: Math.min(limit, 4),
    });
    for (const pattern of patterns) {
      const documentationPattern = isDocumentationPattern(pattern.patternTitle);
      items.push({
        type: documentationPattern ? 'documentation-pattern' : 'reusable-pattern',
        projectName: pattern.sourceProjects[0] ?? null,
        title: pattern.patternTitle,
        excerpt: pattern.explanation,
        notePath: path.join(runtime.config.vaultRoot, '04_Knowledge_Base', documentationPattern ? 'documentation-style-patterns.md' : 'reusable-patterns.md'),
        evidenceQuality: pattern.evidenceQuality ?? 'weak',
        confidence: pattern.confidence ?? 0,
        supportingSources: pattern.supportingEvidence ?? [],
        updatedAt: await safeFileTimestamp(path.join(runtime.config.vaultRoot, '04_Knowledge_Base', documentationPattern ? 'documentation-style-patterns.md' : 'reusable-patterns.md')),
      });
    }
  }

  if (categoryValue === 'research' || categoryValue === 'candidate' || categoryValue === 'research-candidate') {
    const candidatesPath = path.join(runtime.config.vaultRoot, '03_Agent_Notes', 'research-candidates.md');
    const candidatesText = await readText(candidatesPath, '');
    const candidateEntries = parseResearchCandidateEntries(candidatesText).slice(0, limit);
    for (const entry of candidateEntries) {
      items.push({
        type: 'research-candidate',
        projectName: entry.projectName,
        title: entry.title,
        excerpt: entry.finding,
        notePath: candidatesPath,
        evidenceQuality: 'medium',
        confidence: 0.58,
        supportingSources: [{
          sourcePath: candidatesPath,
          sourceKind: 'note',
          sourceSection: entry.title,
          excerpt: entry.finding,
        }],
        updatedAt: await safeFileTimestamp(candidatesPath),
      });
    }
  }

  return items.slice(0, limit);
}

async function gatherLocalBrainContext({
  query,
  currentProjectPath,
  currentProjectName,
  topK = 6,
  runtimeOptions,
  includeProjectSummary = false,
  recentLearningsLimit = 4,
} = {}) {
  const runtime = await loadBrainRuntime(runtimeOptions);
  const readyRuntime = await ensureKnowledgeReady(runtime);
  const resolvedProject = await resolveProjectContext(readyRuntime, {
    projectPath: currentProjectPath,
    projectName: currentProjectName,
  });
  const embedder = new LocalSemanticEmbedder({ pythonExecutable: readyRuntime.config.pythonExecutable });
  const vectorStore = new ChromaVectorStore(readyRuntime.config);
  const retrievalResponse = await retrieveContext({
    queryText: String(query ?? '').trim(),
    topK: Math.max(Number(topK ?? 6), 1),
    embedder,
    vectorStore,
    currentProjectName: resolvedProject?.name ?? '',
  });
  const reasoning = await reasonAboutQuery(readyRuntime.config, readyRuntime.state, retrievalResponse);
  const relatedPatterns = await getRelatedPatternsInternal(readyRuntime, {
    query,
    currentProjectName: resolvedProject?.name,
    topK: Math.min(Math.max(Number(topK ?? 6), 3), 6),
  });
  const recentLearnings = await getRecentLearningsInternal(readyRuntime, {
    currentProjectName: resolvedProject?.name,
    limit: recentLearningsLimit,
  });

  return {
    readyRuntime,
    resolvedProject,
    retrievalResponse,
    reasoning,
    relatedPatterns,
    recentLearnings,
    projectSummary: includeProjectSummary && resolvedProject ? await buildProjectSummaryPayload(readyRuntime, resolvedProject) : null,
  };
}

function buildPatternCatalog(projects) {
  const catalog = new Map();
  for (const project of projects) {
    const reusablePatternRecords = (project.provenance?.reusableSolutions ?? []).length > 0
      ? project.provenance.reusableSolutions
      : (project.reusableSolutions ?? []).map((value) => ({ value, sources: [], evidenceQuality: 'weak', confidence: 0.48 }));
    for (const patternRecord of reusablePatternRecords) {
      const pattern = patternRecord?.value ?? '';
      if (!isHighSignalPattern(pattern)) {
        continue;
      }
      const entry = catalog.get(pattern) ?? {
        pattern,
        explanation: `Reuse this when a project needs the same shape as: ${pattern}`,
        sourceProjects: [],
        whereUsedBefore: [],
        supportingEvidence: [],
        evidenceQuality: patternRecord?.evidenceQuality ?? 'weak',
        confidence: Number(patternRecord?.confidence ?? 0),
        supportCount: 0,
      };
      entry.sourceProjects = uniqueStrings([...entry.sourceProjects, project.name]);
      entry.supportingEvidence = mergeSupportingEvidence(entry.supportingEvidence, patternRecord?.sources ?? []);
      entry.evidenceQuality = strongerEvidenceQuality(entry.evidenceQuality, patternRecord?.evidenceQuality ?? 'weak');
      entry.confidence = Number(Math.max(entry.confidence, Number(patternRecord?.confidence ?? 0)).toFixed(4));
      entry.supportCount = entry.supportingEvidence.length;
      entry.whereUsedBefore = uniqueStrings([
        ...entry.whereUsedBefore,
        ...entry.supportingEvidence.map((source) => source.sourcePath),
      ]);
      catalog.set(pattern, entry);
    }

    const documentationPatternRecords = (project.provenance?.documentationPatterns ?? []).length > 0
      ? project.provenance.documentationPatterns
      : (project.documentationPatterns ?? []).map((value) => ({ value, sources: [], evidenceQuality: 'weak', confidence: 0.48 }));
    for (const patternRecord of documentationPatternRecords) {
      const pattern = patternRecord?.value ?? '';
      if (!isHighSignalPattern(pattern)) {
        continue;
      }
      const entry = catalog.get(pattern) ?? {
        pattern,
        explanation: `Documentation-style pattern grounded in repo-facing README and docs structure: ${pattern}`,
        sourceProjects: [],
        whereUsedBefore: [],
        supportingEvidence: [],
        evidenceQuality: patternRecord?.evidenceQuality ?? 'weak',
        confidence: Number(patternRecord?.confidence ?? 0),
        supportCount: 0,
      };
      entry.sourceProjects = uniqueStrings([...entry.sourceProjects, project.name]);
      entry.supportingEvidence = mergeSupportingEvidence(entry.supportingEvidence, patternRecord?.sources ?? []);
      entry.evidenceQuality = strongerEvidenceQuality(entry.evidenceQuality, patternRecord?.evidenceQuality ?? 'weak');
      entry.confidence = Number(Math.max(entry.confidence, Number(patternRecord?.confidence ?? 0)).toFixed(4));
      entry.supportCount = entry.supportingEvidence.length;
      entry.whereUsedBefore = uniqueStrings([
        ...entry.whereUsedBefore,
        ...entry.supportingEvidence.map((source) => source.sourcePath),
        ...buildDocumentationEvidencePaths(project),
      ]);
      catalog.set(pattern, entry);
    }
  }
  return [...catalog.values()];
}

function buildDocumentationEvidencePaths(project) {
  const preferredPaths = (project.documentationPaths ?? []).filter((relativePath) => /(?:^|\/)(README\.md|ARCHITECTURE\.md|TROUBLESHOOTING\.md|AGENTS\.md|CLAUDE\.md|copilot-instructions\.md)$/i.test(relativePath));
  const fallbackPaths = preferredPaths.length > 0 ? preferredPaths : (project.documentationPaths ?? []).slice(0, 3);
  return uniqueStrings(fallbackPaths.map((relativePath) => path.join(project.rootPath, relativePath))).slice(0, 4);
}

function isDocumentationPattern(patternTitle) {
  return /readme|github showcase|diagram|documentation layout|architecture document|operator guide|troubleshooting|agent guidance|instructions|progressive disclosure|repo presentation/i.test(String(patternTitle ?? ''));
}

function summarizeLearningNote(noteText, project) {
  const entries = parseLearningEntries(noteText);
  for (const entry of entries) {
    if (entry.strong) {
      return entry;
    }
  }

  const sections = parseMarkdownSections(noteText);
  const solution = extractBulletLines(sections.Solution ?? '').slice(0, 3);
  const whyItWorked = extractBulletLines(sections['Why It Worked'] ?? '').slice(0, 3);
  const reusablePattern = extractBulletLines(sections['Reusable Pattern'] ?? '').slice(0, 2);
  const structuredProblem = extractBoldField(noteText, 'Problem');
  const structuredSolution = extractMeaningfulLines(extractBoldField(noteText, 'Solution')).slice(0, 3);
  const structuredWhyItWorked = extractMeaningfulLines(extractBoldField(noteText, 'Why it worked')).slice(0, 3);
  const structuredReusablePattern = extractMeaningfulLines(extractBoldField(noteText, 'Reusable Pattern')).slice(0, 2);
  const structuredFollowUp = extractMeaningfulLines(extractBoldField(noteText, 'Follow-up')).slice(0, 3);
  const fallbackEvidence = buildLearningFallbackEvidence(project);
  const fallback = {
    problem: firstNonEmptyLine(sections.Problem ?? '') ?? firstNonEmptyLine(structuredProblem) ?? project.boundaryRules?.[0] ?? project.recurringProblems?.[0] ?? project.purpose,
    solution: solution.length > 0 ? solution : (structuredSolution.length > 0 ? structuredSolution : (project.validationSurfaces ?? project.reusableSolutions ?? []).slice(0, 3)),
    whyItWorked: whyItWorked.length > 0 ? whyItWorked : (structuredWhyItWorked.length > 0 ? structuredWhyItWorked : (project.boundaryRules ?? project.architecture ?? []).slice(0, 3)),
    reusablePattern: reusablePattern.length > 0 ? reusablePattern : (structuredReusablePattern.length > 0 ? structuredReusablePattern : (project.reusableSolutions ?? []).slice(0, 2)),
    followUp: extractBulletLines(sections['Follow-Up'] ?? '').slice(0, 3).length > 0
      ? extractBulletLines(sections['Follow-Up'] ?? '').slice(0, 3)
      : structuredFollowUp,
    evidenceQuality: fallbackEvidence.evidenceQuality,
    confidence: fallbackEvidence.confidence,
    supportingSources: fallbackEvidence.supportingSources,
  };

  return {
    ...fallback,
    strong: isStrongLearningSummary(fallback),
  };
}

async function buildProjectSummaryPayload(runtime, project) {
  const noteContents = await readProjectNoteContents(runtime.config, project);
  const learnings = summarizeLearningNote(noteContents.learnings?.text ?? '', project);

  return {
    projectName: project.name,
    projectPath: project.rootPath,
    purpose: project.purpose,
    stack: project.stack.slice(0, 10),
    architecture: project.architecture.slice(0, 8),
    boundaries: (project.boundaryRules ?? []).slice(0, 6),
    validationSurfaces: (project.validationSurfaces ?? []).slice(0, 6),
    importantFiles: uniqueStrings([...(project.entryPoints ?? []), ...(project.documentationPaths ?? [])]).slice(0, 10),
    importantModules: (project.modules ?? []).slice(0, 10),
    relevantLearnings: learnings,
    projectPatterns: (project.reusableSolutions ?? []).slice(0, 6),
    documentationPatterns: (project.documentationPatterns ?? []).slice(0, 6),
    provenance: {
      purpose: project.provenance?.purpose ?? null,
      boundaries: pickTopEvidenceItems(project.provenance?.boundaryRules ?? [], 4),
      validationSurfaces: pickTopEvidenceItems(project.provenance?.validationSurfaces ?? [], 4),
      reusableSolutions: pickTopEvidenceItems(project.provenance?.reusableSolutions ?? [], 4),
      documentationPatterns: pickTopEvidenceItems(project.provenance?.documentationPatterns ?? [], 4),
    },
    noteReferences: buildProjectNoteReferences(runtime.config, project.name),
    lastSyncedAt: runtime.state.projects?.[project.name]?.lastSyncedAt ?? null,
  };
}

function buildProjectNoteReferences(config, projectName) {
  const projectRoot = path.join(config.vaultRoot, '01_Projects', projectName);
  return {
    overview: path.join(projectRoot, 'overview.md'),
    architecture: path.join(projectRoot, 'architecture.md'),
    learnings: path.join(projectRoot, 'learnings.md'),
    prompts: path.join(projectRoot, 'prompts.md'),
    knowledge: path.join(config.vaultRoot, '04_Knowledge_Base', 'reusable-patterns.md'),
    documentationStyle: path.join(config.vaultRoot, '04_Knowledge_Base', 'documentation-style-patterns.md'),
  };
}

function buildCapturedLearningEntry({ index, title, projectName, problem, context, solution, whyItWorked, reusablePattern, tags }) {
  const formattedTags = uniqueStrings((tags ?? []).map((tag) => String(tag).trim()).filter(Boolean)).map((tag) => `#${tag.replace(/^#/, '')}`);
  return [
    `## ${index}. ${String(title ?? 'Captured learning').trim() || 'Captured learning'}`,
    '',
    formattedTags.length > 0 ? `Project: [[${projectName}]] | Tags: ${formattedTags.join(' ')}` : `Project: [[${projectName}]]`,
    '',
    '**Problem**',
    String(problem ?? '').trim(),
    '',
    '**Context**',
    String(context ?? '').trim(),
    '',
    '**Solution**',
    String(solution ?? '').trim(),
    '',
    '**Why it worked**',
    String(whyItWorked ?? '').trim(),
    '',
    '**Reusable Pattern**',
    String(reusablePattern ?? '').trim(),
    '',
    '**Follow-up**',
    `Captured via brain.capture_learning on ${timestamp().slice(0, 10)}.`,
  ].join('\n');
}

function buildResearchCandidateEntry({
  title,
  query,
  finding,
  recommendation,
  whyItMatters,
  reusePotential,
  sourceQuality,
  sources,
  projectName,
  promotionCriteria,
  tags,
}) {
  const formattedTags = uniqueStrings((tags ?? []).map((tag) => String(tag).trim()).filter(Boolean)).map((tag) => `#${tag.replace(/^#/, '')}`);
  const sourceLines = renderResearchCandidateSourceLines(sources);
  return [
    `### ${timestamp().slice(0, 10)} | ${String(title ?? 'Research candidate').trim()}`,
    '',
    `Query: ${String(query ?? '').trim()}`,
    `Project: ${projectName ? `[[${projectName}]]` : 'cross-project'}${formattedTags.length > 0 ? ` | Tags: ${formattedTags.join(' ')}` : ''}`,
    `Evidence quality: ${String(sourceQuality ?? '').trim()} | Reuse potential: ${String(reusePotential ?? '').trim()}`,
    '',
    '#### Finding',
    String(finding ?? '').trim(),
    '',
    '#### Why It Matters',
    String(whyItMatters ?? '').trim(),
    '',
    '#### Recommended Adaptation',
    String(recommendation ?? '').trim(),
    '',
    '#### Promotion Criteria',
    String(promotionCriteria ?? 'Promote only after implementation proves the pattern useful more than once.').trim(),
    '',
    '#### Sources',
    ...(sourceLines.length > 0 ? sourceLines : ['- Source list not provided.']),
  ].join('\n');
}

function renderResearchCandidateSourceLines(sources) {
  return uniqueStrings((sources ?? []).map((source) => String(source).trim()).filter(Boolean)).map((source) => `- ${source}`);
}

function appendCanonicalEntry(existing, entry) {
  const base = String(existing ?? '').trim();
  if (!base) {
    return `${entry.trim()}\n`;
  }
  return `${base.trimEnd()}\n\n${entry.trim()}\n`;
}

function normalizeLearningNote(existing, projectName) {
  return normalizeCanonicalNote(existing, `# ${projectName} Learnings`, [
    '#learning #pattern',
    '## Manual Notes',
    'Keep human-reviewed lessons here when they need extra nuance beyond the generated patterns.',
  ]);
}

function normalizeResearchCandidatesNote(existing) {
  return normalizeCanonicalNote(existing, RESEARCH_CANDIDATES_TEMPLATE, [
    '#agent-note #research #candidate',
    '## Manual Notes',
    'Store promising external findings here only when they look reusable but are not yet proven enough for project learnings or reusable-patterns.',
  ]);
}

function normalizeCanonicalNote(existing, fallbackHeading, removableLines = []) {
  const cleaned = stripLegacyManagedSections(existing).trim();
  if (!cleaned) {
    return fallbackHeading;
  }

  const removable = new Set(removableLines);
  const filteredLines = cleaned
    .split('\n')
    .filter((line, index) => {
      const trimmed = line.trim();
      if (index > 0 && /^#(?:[A-Za-z0-9_-]+(?:\s+#?[A-Za-z0-9_-]+)*)$/.test(trimmed) && !trimmed.startsWith('##')) {
        return false;
      }
      return !removable.has(trimmed);
    })
    .join('\n')
    .trim();

  if (!filteredLines) {
    return fallbackHeading;
  }
  if (filteredLines.startsWith('# ')) {
    return filteredLines;
  }
  return `${fallbackHeading}\n\n${filteredLines}`;
}

function nextLearningIndex(noteText) {
  const matches = [...String(noteText ?? '').matchAll(/^##\s+(\d+)\./gm)];
  if (matches.length === 0) {
    return 1;
  }
  return Math.max(...matches.map((match) => Number(match[1] ?? 0))) + 1;
}

function buildResearchNoteTargets(config, projectName) {
  return {
    candidate: path.join(config.vaultRoot, '03_Agent_Notes', 'research-candidates.md'),
    projectLearnings: projectName ? path.join(config.vaultRoot, '01_Projects', projectName, 'learnings.md') : null,
    reusablePatterns: path.join(config.vaultRoot, '04_Knowledge_Base', 'reusable-patterns.md'),
  };
}

function parseLearningEntries(text) {
  const sections = String(text ?? '').split(/^##\s+/m).slice(1);
  return sections.map((rawSection) => {
    const lines = rawSection.split('\n');
    const heading = lines.shift()?.trim() ?? '';
    if (!heading || /capture rule/i.test(heading)) {
      return null;
    }
    const body = lines.join('\n').trim();
    if (!body) {
      return null;
    }
    const problem = extractMeaningfulLines(extractBoldField(body, 'Problem'));
    const solution = extractMeaningfulLines(extractBoldField(body, 'Solution'));
    const whyItWorked = extractMeaningfulLines(extractBoldField(body, 'Why it worked')).length > 0
      ? extractMeaningfulLines(extractBoldField(body, 'Why it worked'))
      : extractMeaningfulLines(extractBoldField(body, 'Why It Worked'));
    const reusablePattern = extractMeaningfulLines(extractBoldField(body, 'Reusable Pattern'));
    const followUp = extractMeaningfulLines(extractBoldField(body, 'Follow-up')).length > 0
      ? extractMeaningfulLines(extractBoldField(body, 'Follow-up'))
      : extractMeaningfulLines(extractBoldField(body, 'Follow-Up'));
    const supportingSources = extractMeaningfulLines(extractBoldField(body, 'Evidence')).map(parseSupportingSourceLine).filter(Boolean);
    const confidenceText = extractBoldField(body, 'Confidence');
    const entry = {
      title: heading,
      problem: problem[0] ?? '',
      solution: solution.slice(0, 3),
      whyItWorked: whyItWorked.slice(0, 3),
      reusablePattern: reusablePattern.slice(0, 2),
      followUp: followUp.slice(0, 3),
      evidenceQuality: inferEvidenceQualityFromConfidenceText(confidenceText, supportingSources),
      confidence: inferConfidenceFromText(confidenceText, supportingSources),
      supportingSources,
    };

    return {
      ...entry,
      strong: isStrongLearningSummary(entry),
    };
  }).filter(Boolean);
}

function parseMarkdownSections(text) {
  const generatedText = extractGeneratedBlock(text);
  const sections = {};
  let currentSection = null;
  for (const rawLine of String(generatedText ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      currentSection = heading[1].trim();
      sections[currentSection] = [];
      continue;
    }
    if (currentSection) {
      sections[currentSection].push(line);
    }
  }
  return Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, value.join('\n').trim()]));
}

function isStrongLearningSummary(summary) {
  const problem = String(summary?.problem ?? '').trim();
  const solution = summary?.solution ?? [];
  const reusablePattern = summary?.reusablePattern ?? [];
  if (!problem || problem.length < 24) {
    return false;
  }
  if (solution.length === 0 && reusablePattern.length === 0) {
    return false;
  }
  return !/does not yet have enough evidence|capture rule|locally indexed software project/i.test(problem.toLowerCase());
}

function isHighSignalPattern(pattern) {
  const normalized = String(pattern ?? '').trim().toLowerCase();
  if (!normalized || normalized.length < 24) {
    return false;
  }
  return !/capture repeatable implementation decisions in dedicated notes/i.test(normalized);
}

function buildLearningFallbackEvidence(project) {
  const evidenceItems = pickTopEvidenceItems([
    ...(project.provenance?.boundaryRules ?? []),
    ...(project.provenance?.validationSurfaces ?? []),
    ...(project.provenance?.reusableSolutions ?? []),
  ], 3);
  return {
    evidenceQuality: maxEvidenceQuality(evidenceItems),
    confidence: Number(maxEvidenceConfidence(evidenceItems).toFixed(4)),
    supportingSources: mergeSupportingEvidence([], evidenceItems.flatMap((item) => item.sources ?? [])),
  };
}

function mergeSupportingEvidence(existingSources, newSources) {
  const keyed = new Map();
  for (const source of [...(existingSources ?? []), ...(newSources ?? [])].filter(Boolean)) {
    const key = `${source.sourcePath}:${source.sourceSection ?? ''}:${source.excerpt ?? ''}`;
    if (!keyed.has(key)) {
      keyed.set(key, {
        sourcePath: source.sourcePath,
        sourceKind: source.sourceKind,
        sourceSection: source.sourceSection ?? null,
        excerpt: source.excerpt ?? '',
      });
    }
  }
  return [...keyed.values()].slice(0, 6);
}

function strongerEvidenceQuality(left, right) {
  const rank = { weak: 1, medium: 2, strong: 3 };
  return (rank[right] ?? 0) > (rank[left] ?? 0) ? right : left;
}

function buildPatternTrustSummary(pattern) {
  const reasons = [`evidence quality: ${pattern.evidenceQuality}`];
  reasons.push(`confidence: ${Number(pattern.confidence ?? 0).toFixed(2)}`);
  if ((pattern.supportCount ?? 0) > 0) {
    reasons.push(`support traces: ${pattern.supportCount}`);
  }
  if ((pattern.supportingEvidence ?? []).length > 0) {
    reasons.push(`nearest evidence: ${summarizeEvidenceSource(pattern.supportingEvidence[0])}`);
  }
  return reasons.join('; ');
}

function inferEvidenceQualityFromConfidenceText(confidenceText, supportingSources) {
  const normalized = String(confidenceText ?? '').toLowerCase();
  if (normalized.includes('strong')) {
    return 'strong';
  }
  if (normalized.includes('medium')) {
    return 'medium';
  }
  if (supportingSources.length >= 2) {
    return 'strong';
  }
  if (supportingSources.length === 1) {
    return 'medium';
  }
  return 'weak';
}

function inferConfidenceFromText(confidenceText, supportingSources) {
  const normalized = String(confidenceText ?? '').toLowerCase();
  const numeric = Number(normalized.match(/\d+(?:\.\d+)?/)?.[0] ?? NaN);
  if (!Number.isNaN(numeric)) {
    return numeric > 1 ? Number((numeric / 100).toFixed(4)) : Number(numeric.toFixed(4));
  }
  if (normalized.includes('strong')) {
    return 0.86;
  }
  if (normalized.includes('medium')) {
    return 0.7;
  }
  if (supportingSources.length >= 2) {
    return 0.82;
  }
  if (supportingSources.length === 1) {
    return 0.68;
  }
  return 0.48;
}

function parseSupportingSourceLine(line) {
  const normalized = String(line ?? '').replace(/^[-*]\s+/, '').trim();
  if (!normalized) {
    return null;
  }
  const [left, excerptPart] = normalized.split('::');
  const segments = left.split('>').map((segment) => segment.trim()).filter(Boolean);
  const sourcePath = segments.shift() ?? normalized;
  const sourceSection = segments.length > 0 ? segments.join(' > ') : null;
  return {
    sourcePath,
    sourceKind: inferSourceKindFromPath(sourcePath),
    sourceSection,
    excerpt: (excerptPart ?? '').trim(),
  };
}

function inferSourceKindFromPath(sourcePath) {
  const normalized = String(sourcePath ?? '').toLowerCase();
  if (/readme/.test(normalized)) {
    return 'readme';
  }
  if (/agents|claude|copilot-instructions/.test(normalized)) {
    return 'agent-guidance';
  }
  if (/package\.json|pyproject|cargo\.toml|go\.mod|pom\.xml|gradle|pubspec\.yaml/.test(normalized)) {
    return 'manifest';
  }
  if (/\.md$|\.mdx$|\.rst$|\.txt$/.test(normalized)) {
    return 'doc';
  }
  return 'note';
}

function extractGeneratedBlock(text) {
  const value = String(text ?? '');
  const aiMatch = value.match(new RegExp(`${escapeRegExp(AI_GENERATED_START)}([\\s\\S]*?)${escapeRegExp(AI_GENERATED_END)}`));
  if (aiMatch?.[1]) {
    return aiMatch[1].trim();
  }
  const brainMatch = value.match(new RegExp(`${escapeRegExp(BRAIN_GENERATED_START)}([\\s\\S]*?)${escapeRegExp(BRAIN_GENERATED_END)}`));
  if (brainMatch?.[1]) {
    return brainMatch[1].trim();
  }
  return value;
}

function extractBulletLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line))
    .map((line) => line.replace(/^-\s+/, '').trim())
    .filter(Boolean);
}

function parseResearchCandidateEntries(text) {
  const matches = String(text ?? '').split(/^###\s+/m).slice(1);
  return matches.map((rawSection) => {
    const lines = rawSection.split('\n');
    const header = lines.shift() ?? '';
    const sectionText = lines.join('\n');
    const title = header.split('|').slice(1).join('|').trim() || header.trim();
    const projectMatch = sectionText.match(/^Project:\s+([^\n|]+)/m);
    const findingMatch = sectionText.match(/#### Finding\n([\s\S]*?)\n\n#### Why It Matters/m);
    return {
      title,
      projectName: projectMatch?.[1]?.replace(/\[\[|\]\]/g, '').trim() || null,
      finding: firstNonEmptyLine(findingMatch?.[1] ?? '') ?? 'Research candidate',
    };
  }).filter((entry) => entry.title);
}

function firstNonEmptyLine(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function tokenizeQuery(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

async function safeFileTimestamp(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.mtime.toISOString();
  } catch {
    return null;
  }
}

async function refreshQueryHistoryNote(config, state) {
  await writeCanonicalQueryHistoryNote(config, state.queryHistory ?? []);
}

function extractBoldField(text, label) {
  const value = String(text ?? '');
  const pattern = new RegExp(`\\*\\*${escapeRegExp(label)}\\*\\*\\s*\\n([\\s\\S]*?)(?=\\n\\*\\*[^\\n]+\\*\\*|$)`, 'i');
  const match = value.match(pattern);
  return match?.[1]?.trim() ?? '';
}

function extractMeaningfulLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

function normalizeCaptureField(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function validateCapturedLearningInput({ title, problem, context, solution, whyItWorked, reusablePattern }) {
  const fields = {
    title: normalizeCaptureField(title),
    problem: normalizeCaptureField(problem),
    context: normalizeCaptureField(context),
    solution: normalizeCaptureField(solution),
    whyItWorked: normalizeCaptureField(whyItWorked),
    reusablePattern: normalizeCaptureField(reusablePattern),
  };
  const errors = Object.entries(fields)
    .filter(([, value]) => !isHighSignalCaptureField(value))
    .map(([key]) => key);

  if (!containsTechnicalAnchor(Object.values(fields).join(' '))) {
    errors.push('technical-anchor');
  }

  if (errors.length > 0) {
    throw new Error(`Learning rejected because it is too generic or weak: ${errors.join(', ')}`);
  }
}

function validateResearchCandidateInput({ title, query, finding, recommendation, whyItMatters, reusePotential, sourceQuality }) {
  const fields = [title, query, finding, recommendation, whyItMatters, reusePotential, sourceQuality].map((value) => normalizeCaptureField(value));
  if (fields.some((value) => !isHighSignalCaptureField(value, { minLength: 18 }))) {
    throw new Error('Research candidate rejected because the finding is too generic or incomplete.');
  }
}

function isHighSignalCaptureField(value, { minLength = 24 } = {}) {
  if (!value || value.length < minLength) {
    return false;
  }
  return !/best practice|good pattern|improve code quality|follow existing pattern|general guidance|use best practices/i.test(value.toLowerCase());
}

function containsTechnicalAnchor(value) {
  return /(npm run|pytest|go test|cargo test|dotnet test|mvn |gradle |\/|\.[a-z]{2,4}\b|token|auth|retry|deploy|schema|migration|operator|runtime|vault|state|cache|module|cli|mcp|docs|prompt|pattern)/i.test(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}