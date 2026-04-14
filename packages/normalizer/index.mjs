import path from 'node:path';

import {
  createEvidenceItem,
  createEvidenceSource,
  EVIDENCE_MODEL_VERSION,
  pickTopEvidenceItems,
} from '../provenance/index.mjs';
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
  const boundaryRules = analysis.boundaryRules ?? [];
  const validationSurfaces = analysis.validationSurfaces ?? [];
  const provenance = normalizeProjectProvenance(analysis, {
    modules,
    workflows,
    integrationSurfaces,
  });
  const corpusSections = [
    `Project: ${analysis.name}`,
    `Purpose: ${analysis.purpose}`,
    `Summary: ${analysis.summary}`,
    `Stack: ${(analysis.techStack ?? []).join(', ')}`,
    `Languages: ${(analysis.languages ?? []).join(', ')}`,
    `Architecture: ${(analysis.architecturePatterns ?? []).join('; ')}`,
    `Modules: ${modules.join(', ')}`,
    `Workflows: ${workflows.join('; ')}`,
    `Boundary rules: ${boundaryRules.join('; ')}`,
    `Validation surfaces: ${validationSurfaces.join('; ')}`,
    `Integration surfaces: ${integrationSurfaces.join('; ')}`,
    `Recurring problems: ${(analysis.problemsSolved ?? []).join('; ')}`,
    `Reusable solutions: ${(analysis.reusablePatterns ?? []).join('; ')}`,
    `Documentation quality signals: ${documentationQualitySignals.join('; ')}`,
    `Documentation patterns: ${documentationPatterns.join('; ')}`,
    `Risk notes: ${riskNotes.join('; ')}`,
    `Improvement ideas: ${(analysis.potentialImprovements ?? []).join('; ')}`,
    `Prompt anchors: ${prompts.join('; ')}`,
    `Evidence traces: ${buildEvidenceTraceSummary(provenance)}`,
  ];

  return {
    id: sha256(`${analysis.name}:${analysis.fingerprint}`),
    slug: slugify(analysis.name),
    name: analysis.name,
    rootPath: analysis.rootPath,
    evidenceModelVersion: analysis.evidenceModelVersion ?? EVIDENCE_MODEL_VERSION,
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
    boundaryRules,
    validationSurfaces,
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
    provenance,
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

function normalizeProjectProvenance(analysis, { modules, workflows, integrationSurfaces }) {
  return {
    purpose: analysis.provenance?.purpose ?? createEvidenceItem({
      category: 'purpose',
      value: analysis.purpose,
      sources: [],
      derivedFrom: 'heuristic-fallback',
      confidence: 0.34,
      evidenceQuality: 'weak',
    }),
    architecture: analysis.provenance?.architecture ?? [],
    modules: modules.map((moduleName) => createEvidenceItem({
      category: 'modules',
      value: moduleName,
      sources: [createEvidenceSource({
        sourcePath: moduleName,
        sourceKind: 'directory',
        sourceSection: 'top-level',
        excerpt: `Detected top-level module boundary ${moduleName}.`,
      })],
      derivedFrom: 'directory-layout',
    })).filter(Boolean),
    workflows: buildWorkflowProvenance(analysis, workflows),
    integrationSurfaces: buildIntegrationSurfaceProvenance(analysis, integrationSurfaces),
    boundaryRules: analysis.provenance?.boundaryRules ?? [],
    validationSurfaces: analysis.provenance?.validationSurfaces ?? [],
    recurringProblems: analysis.provenance?.recurringProblems ?? [],
    reusableSolutions: analysis.provenance?.reusableSolutions ?? [],
    documentationPatterns: analysis.provenance?.documentationPatterns ?? [],
    documentationQualitySignals: analysis.provenance?.documentationQualitySignals ?? [],
  };
}

function buildWorkflowProvenance(analysis, workflows) {
  return workflows.map((workflow) => {
    if (/Entrypoint available at /i.test(workflow)) {
      const entryPoint = workflow.replace(/^Entrypoint available at /i, '').trim();
      return createEvidenceItem({
        category: 'workflows',
        value: workflow,
        sources: [createEvidenceSource({
          sourcePath: entryPoint,
          sourceKind: 'manifest',
          sourceSection: 'entrypoint',
          excerpt: `Entrypoint discovered at ${entryPoint}.`,
        })],
        derivedFrom: 'package-manifest',
      });
    }
    if (/docs-as-code/i.test(workflow)) {
      return createEvidenceItem({
        category: 'workflows',
        value: workflow,
        sources: (analysis.documentationPaths ?? []).slice(0, 2).map((relativePath) => createEvidenceSource({
          sourcePath: relativePath,
          sourceKind: 'doc',
          sourceSection: 'documentation-surface',
          excerpt: 'Documentation path participates in the operating surface.',
        })),
        derivedFrom: 'doc-structure',
      });
    }
    if (/Automation-first/i.test(workflow)) {
      const sources = (analysis.provenance?.validationSurfaces ?? []).slice(0, 2).flatMap((item) => item.sources ?? []);
      return createEvidenceItem({
        category: 'workflows',
        value: workflow,
        sources,
        derivedFrom: sources.length > 0 ? 'manifest-script' : 'heuristic-inference',
      });
    }
    if (/verification surface/i.test(workflow)) {
      const sources = (analysis.provenance?.validationSurfaces ?? []).slice(0, 2).flatMap((item) => item.sources ?? []);
      return createEvidenceItem({
        category: 'workflows',
        value: workflow,
        sources,
        derivedFrom: sources.length > 0 ? 'manifest-script' : 'heuristic-inference',
      });
    }
    return createEvidenceItem({
      category: 'workflows',
      value: workflow,
      sources: [],
      derivedFrom: 'heuristic-inference',
      confidence: 0.48,
      evidenceQuality: 'weak',
    });
  }).filter(Boolean);
}

function buildIntegrationSurfaceProvenance(analysis, integrationSurfaces) {
  return integrationSurfaces.map((surface) => {
    const sourcePath = (analysis.entryPoints ?? [])[0] ?? (analysis.documentationPaths ?? [])[0] ?? analysis.rootPath;
    const sourceKind = sourcePath === analysis.rootPath ? 'directory' : (/\.(md|mdx|rst|txt)$/i.test(sourcePath) ? 'doc' : 'manifest');
    return createEvidenceItem({
      category: 'integrationSurfaces',
      value: surface,
      sources: [createEvidenceSource({
        sourcePath,
        sourceKind,
        sourceSection: sourceKind === 'directory' ? 'scan' : 'integration-surface',
        excerpt: surface,
      })],
      derivedFrom: /No strong integration surfaces/i.test(surface) ? 'heuristic-inference' : 'package-manifest',
      confidence: /No strong integration surfaces/i.test(surface) ? 0.38 : undefined,
      evidenceQuality: /No strong integration surfaces/i.test(surface) ? 'weak' : undefined,
    });
  }).filter(Boolean);
}

function buildEvidenceTraceSummary(provenance) {
  const highlights = [
    provenance.purpose,
    ...pickTopEvidenceItems(provenance.boundaryRules ?? [], 2),
    ...pickTopEvidenceItems(provenance.validationSurfaces ?? [], 2),
    ...pickTopEvidenceItems(provenance.documentationPatterns ?? [], 1),
  ].filter(Boolean).slice(0, 6);

  return highlights.map((item) => {
    const firstSource = item.sources?.[0];
    if (!firstSource) {
      return `${item.category}: ${item.value} [${item.evidenceQuality}]`;
    }
    const section = firstSource.sourceSection ? ` > ${firstSource.sourceSection}` : '';
    return `${item.category}: ${item.value} [${item.evidenceQuality} | ${firstSource.sourcePath}${section}]`;
  }).join('; ');
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
  if ((analysis.validationSurfaces ?? []).length > 0) {
    prompts.push(`Which validation command or workflow proves a change in ${analysis.name} is safe?`);
  }
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