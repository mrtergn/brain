import path from 'node:path';

import { sha256, slugify, timestamp, uniqueStrings } from '../shared/index.mjs';

export function normalizeProject(parsedProject) {
  const { analysis, parsedAt } = parsedProject;
  const modules = (analysis.topDirectories ?? []).slice(0, 12);
  const workflows = inferWorkflows(analysis);
  const integrationSurfaces = inferIntegrationSurfaces(analysis);
  const riskNotes = inferRiskNotes(analysis);
  const prompts = buildPromptAnchors(analysis);
  const tags = buildTags(analysis);
  const documentationPatterns = analysis.documentationPatterns ?? [];
  const documentationQualitySignals = analysis.documentationQualitySignals ?? [];
  const corpusSections = [
    `Project: ${analysis.name}`,
    `Purpose: ${analysis.purpose}`,
    `Summary: ${analysis.summary}`,
    `Stack: ${(analysis.techStack ?? []).join(', ')}`,
    `Languages: ${(analysis.languages ?? []).join(', ')}`,
    `Architecture: ${(analysis.architecturePatterns ?? []).join('; ')}`,
    `Modules: ${modules.join(', ')}`,
    `Workflows: ${workflows.join('; ')}`,
    `Integration surfaces: ${integrationSurfaces.join('; ')}`,
    `Recurring problems: ${(analysis.problemsSolved ?? []).join('; ')}`,
    `Reusable solutions: ${(analysis.reusablePatterns ?? []).join('; ')}`,
    `Documentation quality signals: ${documentationQualitySignals.join('; ')}`,
    `Documentation patterns: ${documentationPatterns.join('; ')}`,
    `Risk notes: ${riskNotes.join('; ')}`,
    `Improvement ideas: ${(analysis.potentialImprovements ?? []).join('; ')}`,
    `Prompt anchors: ${prompts.join('; ')}`,
  ];

  return {
    id: sha256(`${analysis.name}:${analysis.fingerprint}`),
    slug: slugify(analysis.name),
    name: analysis.name,
    rootPath: analysis.rootPath,
    fingerprint: analysis.fingerprint,
    parsedAt,
    normalizedAt: timestamp(),
    purpose: analysis.purpose,
    summary: analysis.summary,
    stack: analysis.techStack ?? [],
    languages: analysis.languages ?? [],
    architecture: analysis.architecturePatterns ?? [],
    modules,
    workflows,
    integrationSurfaces,
    recurringProblems: analysis.problemsSolved ?? [],
    reusableSolutions: analysis.reusablePatterns ?? [],
    documentationPatterns,
    documentationQualitySignals,
    documentationQualityScore: analysis.documentationQualityScore ?? 0,
    riskNotes,
    improvementIdeas: analysis.potentialImprovements ?? [],
    promptAnchors: prompts,
    documentationPaths: analysis.documentationPaths ?? [],
    entryPoints: analysis.entryPoints ?? [],
    sourceStats: analysis.sourceStats,
    warnings: analysis.warnings ?? [],
    tags,
    corpusText: corpusSections.join('\n\n'),
    promptTemplateContext: {
      project: analysis.name,
      stack: analysis.techStack ?? [],
      architecture: analysis.architecturePatterns ?? [],
      keyModules: modules,
    },
    noteTargets: buildNoteTargets(analysis.name),
    analysis,
  };
}

function inferWorkflows(analysis) {
  const workflows = new Set();
  for (const entryPoint of analysis.entryPoints ?? []) {
    workflows.add(`Entrypoint available at ${entryPoint}`);
  }
  if ((analysis.documentationPaths ?? []).some((item) => item.startsWith('docs/'))) {
    workflows.add('Repository uses docs-as-code for operational knowledge.');
  }
  if ((analysis.architecturePatterns ?? []).some((pattern) => /automation|scriptable/i.test(pattern))) {
    workflows.add('Automation-first workflow with scriptable local entrypoints.');
  }
  if ((analysis.hasTests ?? false) === true) {
    workflows.add('Repository exposes a verification surface with tests or specs.');
  }
  if (workflows.size === 0) {
    workflows.add('No explicit workflow surface was detected beyond the main project structure.');
  }
  return [...workflows];
}

function inferIntegrationSurfaces(analysis) {
  const surfaces = new Set();
  for (const dependency of analysis.dependencies ?? []) {
    if (/redis|postgres|mysql|sqlite|mongo|cosmos/i.test(dependency)) {
      surfaces.add(`Data dependency: ${dependency}`);
    }
    if (/docker|kubernetes|nginx/i.test(dependency)) {
      surfaces.add(`Deployment/runtime dependency: ${dependency}`);
    }
    if (/auth|oauth|passport|jwt/i.test(dependency)) {
      surfaces.add(`Authentication surface: ${dependency}`);
    }
  }
  for (const entryPoint of analysis.entryPoints ?? []) {
    if (/server|api|main|Program\.cs|index/.test(entryPoint)) {
      surfaces.add(`Code entry surface: ${entryPoint}`);
    }
  }
  if (surfaces.size === 0) {
    surfaces.add('No strong integration surfaces were inferred from the current scan window.');
  }
  return [...surfaces].slice(0, 10);
}

function inferRiskNotes(analysis) {
  const risks = new Set();
  if ((analysis.warnings ?? []).length > 0) {
    risks.add('Scan completed with warnings or truncation; inspect project details before acting on this memory.');
  }
  if ((analysis.hasTests ?? false) === false) {
    risks.add('Repository does not expose obvious automated verification paths.');
  }
  if ((analysis.documentationPaths ?? []).length === 0) {
    risks.add('Repository lacks clear documentation signals, which raises interpretation risk.');
  }
  if ((analysis.dependencies ?? []).length > 12) {
    risks.add('Dependency surface is wide enough that changes should be validated cautiously.');
  }
  if (risks.size === 0) {
    risks.add('No elevated structural risks were inferred from the current snapshot.');
  }
  return [...risks];
}

function buildPromptAnchors(analysis) {
  const stackPreview = analysis.techStack?.slice(0, 5).join(', ') || 'unknown stack';
  const prompts = [
    `What problem is ${analysis.name} solving, and where is that visible in the repo?`,
    `Which solution from ${analysis.name} is safest to reuse in a similar project?`,
    `Before changing ${analysis.name}, summarize the relevant modules, stack (${stackPreview}), and risks.`,
    `If I am debugging a similar issue, which ${analysis.name} notes should I read first?`,
  ];
  if ((analysis.documentationPatterns ?? []).length > 0) {
    prompts.push(`If I need to improve a README, architecture doc, or agent instructions, which documentation patterns from ${analysis.name} should I reuse?`);
  }
  return uniqueStrings(prompts);
}

function buildTags(analysis) {
  return uniqueStrings([
    'project',
    'learning',
    'architecture',
    'retrieval',
    ((analysis.documentationPatterns ?? []).length > 0 || (analysis.documentationPaths ?? []).length > 0) ? 'documentation' : '',
    ...((analysis.languages ?? []).map((value) => slugify(value))),
    ...((analysis.techStack ?? []).map((value) => slugify(value))),
  ]).slice(0, 16);
}

function buildNoteTargets(projectName) {
  const projectFolder = path.join('01_Projects', projectName);
  return {
    overview: path.join(projectFolder, 'overview.md'),
    architecture: path.join(projectFolder, 'architecture.md'),
    learnings: path.join(projectFolder, 'learnings.md'),
    prompts: path.join(projectFolder, 'prompts.md'),
    knowledge: path.join('04_Knowledge_Base', 'reusable-patterns.md'),
    documentationStyle: path.join('04_Knowledge_Base', 'documentation-style-patterns.md'),
  };
}