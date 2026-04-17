import { getProjectNeighbors } from '../project-graph/index.mjs';
import { uniqueStrings } from '../shared/index.mjs';
import {
  listDecisionJournal,
  listDistillationCandidates,
  listInvalidationEntries,
  listPromptPatterns,
  listRecentEpisodes,
  loadProjectGraph,
  loadWorkspaceState,
} from '../state-manager/index.mjs';

export async function assembleLiveContext({
  runtime,
  query,
  resolvedProject,
  retrievalResponse,
  reasoning,
  relatedPatterns,
  recentLearnings,
  projectSummary,
  retrievalProfile = 'default',
  workspaceId = null,
  includePreflight = false,
  embedderRuntime = null,
} = {}) {
  const currentProjectName = resolvedProject?.name ?? null;
  const [recentEpisodes, distillationCandidates, recentDecisions, invalidationEntries, promptPatterns, graph, workspace] = await Promise.all([
    listRecentEpisodes(runtime.config, {
      currentProjectName,
      query,
      limit: 3,
    }),
    listDistillationCandidates(runtime.config, {
      currentProjectName,
      limit: 3,
    }),
    listDecisionJournal(runtime.config, {
      currentProjectName,
      limit: 3,
    }),
    listInvalidationEntries(runtime.config, {
      currentProjectName,
      activeOnly: true,
      limit: 3,
    }),
    listPromptPatterns(runtime.config, {
      currentProjectName,
      limit: 3,
    }),
    loadProjectGraph(runtime.config),
    workspaceId ? loadWorkspaceState(runtime.config, workspaceId) : Promise.resolve(null),
  ]);
  const graphNeighbors = currentProjectName ? getProjectNeighbors(graph, currentProjectName, 4) : [];

  const topResults = (retrievalResponse?.results ?? []).slice(0, 3);
  const validationHints = uniqueStrings([
    ...(projectSummary?.validationSurfaces ?? []).slice(0, 4),
    ...(projectSummary?.boundaries ?? []).slice(0, 2).map((item) => `Respect boundary: ${item}`),
    ...recentEpisodes.map((episode) => episode.summary).filter(Boolean),
  ]).slice(0, 6);

  return {
    retrievalProfile,
    scope: {
      currentProjectName,
      currentProjectPath: resolvedProject?.rootPath ?? null,
      relatedProjects: reasoning?.relatedProjects ?? [],
    },
    noteReferences: projectSummary?.noteReferences ?? {
      overview: null,
      architecture: null,
      learnings: null,
      prompts: null,
      knowledge: null,
      documentationStyle: null,
    },
    topEvidence: topResults.map((result) => ({
      project: result.project,
      noteType: result.noteType,
      sourcePath: result.sourcePath,
      evidenceQuality: result.evidenceQuality,
      confidence: result.confidence,
      whyTrusted: result.whyTrusted,
    })),
    validationHints,
    recentEpisodes: recentEpisodes.map((episode) => ({
      id: episode.id,
      at: episode.at,
      source: episode.source,
      query: episode.query,
      summary: episode.summary,
      currentProjectName: episode.currentProjectName,
      evidenceQuality: episode.evidenceQuality,
      confidence: episode.confidence,
    })),
    distillationCandidates: distillationCandidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      status: candidate.status,
      targetType: candidate.targetType,
      targetPath: candidate.targetPath,
      evidenceQuality: candidate.evidenceQuality,
      confidence: candidate.confidence,
      summary: candidate.summary,
    })),
    recentDecisions: recentDecisions.map((decision) => ({
      id: decision.id,
      at: decision.at,
      summary: decision.summary,
      recommendedAction: decision.recommendedAction,
      evidenceQuality: decision.evidenceQuality,
      confidence: decision.confidence,
    })),
    invalidationWarnings: invalidationEntries.map((entry) => ({
      id: entry.id,
      projectName: entry.projectName,
      staleReasons: entry.staleReasons,
      affectedArtifacts: entry.affectedArtifacts,
      status: entry.status,
    })),
    promptPatterns: promptPatterns.map((pattern) => ({
      id: pattern.id,
      normalizedText: pattern.normalizedText,
      retrievalProfile: pattern.retrievalProfile,
      useCount: pattern.useCount,
    })),
    graphContext: {
      neighbors: graphNeighbors,
    },
    workspace: workspace ? {
      id: workspace.id,
      task: workspace.task,
      status: workspace.status,
      hypotheses: workspace.hypotheses,
      findings: workspace.findings,
      handoffs: workspace.handoffs,
    } : null,
    preflightSimulation: includePreflight ? {
      affectedProjects: uniqueStrings([currentProjectName, ...graphNeighbors.map((neighbor) => neighbor.project)]).filter(Boolean),
      staleWarnings: invalidationEntries.flatMap((entry) => entry.staleReasons ?? []).slice(0, 6),
      validationPlan: validationHints.slice(0, 4),
      relatedPatterns: promptPatterns.map((pattern) => pattern.normalizedText).slice(0, 3),
    } : null,
    provenanceSummary: uniqueStrings([
      ...topResults.map((result) => `${result.project}/${result.noteType} (${result.evidenceQuality} ${result.confidence})`),
      ...(relatedPatterns ?? []).slice(0, 2).map((pattern) => `Pattern: ${pattern.patternTitle} (${pattern.evidenceQuality} ${pattern.confidence})`),
      ...(recentLearnings ?? []).slice(0, 2).map((learning) => `Learning: ${learning.title} (${learning.evidenceQuality} ${learning.confidence})`),
    ]).slice(0, 6),
    embedderRuntime: embedderRuntime ? {
      backend: embedderRuntime.backend,
      usedRunner: Boolean(embedderRuntime.usedRunner),
    } : null,
  };
}
