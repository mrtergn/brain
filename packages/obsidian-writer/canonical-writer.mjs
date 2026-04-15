import fs from 'node:fs/promises';
import path from 'node:path';

import {
  buildGlobalNotePaths,
  buildProjectNotePaths,
  CANONICAL_GLOBAL_NOTES,
  CANONICAL_PROJECT_NOTE_TYPES,
  cleanupDeprecatedVaultArtifacts,
  ensureVaultFolders,
  isLegacyManagedText,
  stripLegacyManagedSections,
} from '../vault-contract/index.mjs';
import {
  ensureDir,
  readText,
  timestamp,
  truncate,
  uniqueStrings,
  writeText,
} from '../shared/index.mjs';
import {
  maxEvidenceConfidence,
  maxEvidenceQuality,
  pickTopEvidenceItems,
  summarizeEvidenceSource,
} from '../provenance/index.mjs';

const STATIC_FOLDER_READMES = {
  '00_Inbox/README.md': [
    '# Inbox',
    '',
    'Use this folder only for temporary raw captures that have not been distilled into project notes yet.',
  ].join('\n'),
  '02_Experiments/README.md': [
    '# Experiments',
    '',
    'Use this folder for one-off prototypes or validation notes that are not yet durable memory.',
  ].join('\n'),
  '03_Agent_Notes/README.md': [
    '# Agent Notes',
    '',
    'This folder holds practical operator and agent guidance such as query history, debugging insights, workflow notes, and optional research candidates.',
  ].join('\n'),
  '04_Knowledge_Base/README.md': [
    '# Knowledge Base',
    '',
    'This folder is reserved for cross-project reusable engineering knowledge. Project-mirror notes do not belong here.',
    '',
    'Use `reusable-patterns.md` for implementation patterns and `documentation-style-patterns.md` for GitHub-facing documentation and repo-presentation patterns.',
  ].join('\n'),
  '05_Daily_Logs/README.md': [
    '# Daily Logs',
    '',
    'This folder exists only for explicit manual use. The runtime does not generate daily or sync journals here by default.',
  ].join('\n'),
  '06_Summaries/README.md': [
    '# Summaries',
    '',
    'Portfolio-level summaries belong here when they materially improve navigation or confidence calibration.',
  ].join('\n'),
  '99_System/README.md': [
    '# System',
    '',
    'System notes describe how the brain is structured and operated. They are knowledge notes, not runtime state.',
  ].join('\n'),
};

const MANAGED_BY = 'brain';

const DEFAULT_QUERY_HISTORY_SECTIONS = {
  usefulPatterns: [
    '- Similar bug fix plus symptom plus subsystem plus repo.',
    '- Safe place to add or change a feature without breaking a named boundary.',
    '- Prior workaround plus environment or deployment detail.',
    '- Existing validation path for a risky area such as pricing, execution, or state recovery.',
  ],
  whatBelongsHere: [
    '- Keep only short, reusable query shapes that repeatedly produce useful recall.',
    '- Keep named boundaries, failure modes, and validation prompts that help future work start in the right place.',
    '- Keep cross-project retrieval hints only when they stay concrete and decision-oriented.',
  ],
  runtimeStateOnly: [
    '- Raw query logs, smoke checks, doctor probes, audit prompts, result ids, and long implementation requests stay in `data/state/`.',
    '- Exact one-off transcript rows and repeated validation commands do not belong in this note.',
  ],
  promotionCriteria: [
    '- Promote wording here only after it proves useful in at least two real tasks.',
    '- Move repo-specific wording into that project\'s prompts note when it stops being cross-project guidance.',
    '- Move durable cross-project guidance into [[04_Knowledge_Base/reusable-patterns|Reusable Patterns]] instead of growing this note into a transcript archive.',
  ],
  lastCurated: [
    `- ${timestamp().slice(0, 10)} by brain sync.`,
  ],
};

export async function bootstrapVault(config) {
  await ensureVaultFolders(config.vaultRoot);
  await Promise.all(Object.entries(STATIC_FOLDER_READMES).map(async ([relativePath, content]) => {
    await ensureNoteIfMissing(path.join(config.vaultRoot, relativePath), content);
  }));

  const globalPaths = buildGlobalNotePaths(config.vaultRoot);
  await ensureCanonicalKnowledgeNotes(config, globalPaths);
  await createLocalRunner(config);
}

export async function syncNotes(config, state, projects, { changedProjects = [], trigger = 'sync', failures = [], knowledgeProjects = projects } = {}) {
  await bootstrapVault(config);
  const syncedAt = timestamp();
  const removedPaths = await cleanupDeprecatedVaultArtifacts(config.vaultRoot, projects.map((project) => project.name));

  for (const project of projects) {
    await ensureProjectFolderCanonical(config, project);
  }

  await writeManagedKnowledgeNotes(config, state, knowledgeProjects);

  return {
    date: syncedAt.slice(0, 10),
    trigger,
    startedAt: syncedAt,
    completedAt: syncedAt,
    updatedProjects: changedProjects,
    unchangedProjects: projects.filter((project) => !changedProjects.includes(project.name)).map((project) => project.name),
    failures,
    removedPaths,
    note: `updated ${changedProjects.length} project(s), removed ${removedPaths.length} deprecated vault artifact(s), failures ${failures.length}`,
  };
}

export async function readProjectNoteContents(config, project) {
  const notePaths = buildProjectNotePaths(config.vaultRoot, project.name);
  const entries = await Promise.all(Object.entries(notePaths).map(async ([noteType, filePath]) => {
    const text = await readText(filePath, '');
    return [noteType, text ? { text, sourcePath: filePath, tags: [...(project.tags ?? []), noteType] } : null];
  }));
  return Object.fromEntries(entries);
}

export async function readGlobalKnowledgeNoteContents(config) {
  const globalPaths = buildGlobalNotePaths(config.vaultRoot);
  const noteDefinitions = [
    ['reusablePatterns', globalPaths.reusablePatterns, ['knowledge', 'reusable-patterns']],
    ['documentationStylePatterns', globalPaths.documentationStylePatterns, ['knowledge', 'documentation-style-patterns']],
  ];
  const entries = await Promise.all(noteDefinitions.map(async ([key, filePath, tags]) => {
    const text = await readText(filePath, '');
    return [key, text ? { text, sourcePath: filePath, tags } : null];
  }));
  return Object.fromEntries(entries);
}

export async function writeManagedKnowledgeNotes(config, state, projects) {
  await bootstrapVault(config);
  const globalPaths = buildGlobalNotePaths(config.vaultRoot);

  await ensureCanonicalKnowledgeNotes(config, globalPaths);
  await ensureCanonicalSummaryNote(globalPaths.projectIndex, renderProjectIndexNote(projects));
  await ensureCanonicalSummaryNote(globalPaths.portfolioSummary, renderPortfolioSummaryNote(projects));
  await ensureCanonicalSummaryNote(globalPaths.documentationStylePatterns, renderDocumentationStylePatternsNote(projects));
  await writeQueryHistoryNote(config, state.queryHistory ?? []);
}

export async function writeQueryHistoryNote(config, queryHistory) {
  const globalPaths = buildGlobalNotePaths(config.vaultRoot);
  const existing = await readText(globalPaths.queryHistory, '');
  await writeText(globalPaths.queryHistory, renderQueryHistoryNote(existing));
}

async function ensureCanonicalKnowledgeNotes(config, globalPaths) {
  await ensureCanonicalStaticNote(globalPaths.reusablePatterns, renderReusablePatternsTemplate(), { preserveExisting: true });
  await ensureCanonicalStaticNote(globalPaths.documentationStylePatterns, renderDocumentationStylePatternsSeed(), { preserveExisting: true });
  await ensureCanonicalStaticNote(globalPaths.debuggingInsights, renderDebuggingInsightsTemplate(), { preserveExisting: true });
  await ensureCanonicalStaticNote(globalPaths.agentWorkflowNotes, renderAgentWorkflowNotesTemplate(), { preserveExisting: true });
  await ensureOptionalCanonicalStaticNote(globalPaths.researchCandidates, renderResearchCandidatesTemplate());
  await ensureCanonicalStaticNote(globalPaths.architecture, renderSystemArchitectureNote(config), { preserveExisting: true });
  await ensureCanonicalStaticNote(globalPaths.operations, renderOperationsNote(), { preserveExisting: true });
  await ensureCanonicalStaticNote(globalPaths.retrieval, renderRetrievalNote(), { preserveExisting: true });
}

async function ensureProjectFolderCanonical(config, project) {
  const notePaths = buildProjectNotePaths(config.vaultRoot, project.name);
  await ensureDir(path.dirname(notePaths.overview));

  const renderers = {
    overview: renderOverviewNote,
    architecture: renderArchitectureNote,
    learnings: renderLearningsNote,
    prompts: renderPromptsNote,
  };

  for (const noteType of CANONICAL_PROJECT_NOTE_TYPES) {
    const filePath = notePaths[noteType];
    const existing = await readText(filePath, '');
    const nextText = existing && !shouldRewriteCanonicalNote(existing)
      ? normalizeExistingProjectNote(project, noteType, existing)
      : renderers[noteType](project);
    if (String(existing).trim() === String(nextText).trim()) {
      continue;
    }
    await writeText(filePath, nextText);
  }
}

function shouldRewriteCanonicalNote(existing) {
  const normalized = String(existing ?? '').trim();
  if (!normalized) {
    return true;
  }
  if (isLegacyManagedText(normalized)) {
    return true;
  }
  return /Store durable human context here\. The generated project snapshot below updates automatically\.|Capture architecture decisions or design rationale here\. Generated structure details remain below\.|Keep human-reviewed lessons here when they need extra nuance beyond the generated patterns\.|Add project-specific prompts here when you discover better retrieval or debugging instructions\./i.test(normalized);
}

async function ensureCanonicalStaticNote(filePath, content, { preserveExisting = true } = {}) {
  const existing = await readText(filePath, '');
  if (existing) {
    if (preserveExisting && !shouldRewriteCanonicalNote(existing)) {
      return;
    }
    if (preserveExisting) {
      await writeText(filePath, preserveCanonicalStaticContent(existing, content));
      return;
    }
  }
  await writeText(filePath, content);
}

async function ensureOptionalCanonicalStaticNote(filePath, content) {
  const existing = await readText(filePath, '');
  if (!existing) {
    return;
  }
  if (!shouldRewriteCanonicalNote(existing)) {
    return;
  }
  await writeText(filePath, preserveCanonicalStaticContent(existing, content));
}

async function ensureCanonicalSummaryNote(filePath, content) {
  const existing = await readText(filePath, '');
  if (existing && !shouldRewriteCanonicalNote(existing) && contentHashishEqual(existing, content)) {
    return;
  }
  await writeText(filePath, content);
}

async function ensureNoteIfMissing(filePath, content) {
  const existing = await readText(filePath, '');
  if (existing) {
    return;
  }
  await writeText(filePath, content);
}

function normalizeExistingProjectNote(project, noteType, existingText) {
  if (noteType === 'learnings') {
    return normalizeExistingLearningsNote(project, existingText);
  }

  const renderers = {
    overview: renderOverviewNote,
    architecture: renderArchitectureNote,
    prompts: renderPromptsNote,
  };
  return renderers[noteType](project, existingText);
}

function renderManagedFrontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value == null || value === '') {
      continue;
    }
    lines.push(`${key}: ${renderFrontmatterScalar(value)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function renderFrontmatterScalar(value) {
  const normalized = String(value ?? '').trim();
  if (/^[A-Za-z0-9_.\/-]+$/.test(normalized)) {
    return normalized;
  }
  return JSON.stringify(normalized);
}

function stripFrontmatter(text) {
  const value = String(text ?? '');
  if (!value.startsWith('---\n')) {
    return value;
  }
  const endIndex = value.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    return value;
  }
  return value.slice(endIndex + 5);
}

function stripManagedHeadingBlock(text) {
  const cleaned = stripLegacyManagedSections(stripFrontmatter(text)).trim();
  if (!cleaned) {
    return '';
  }
  const lines = cleaned.split('\n');
  let index = 0;
  while (index < lines.length && !lines[index].trim()) {
    index += 1;
  }
  if (index < lines.length && /^#\s+/.test(lines[index].trim())) {
    index += 1;
  }
  while (index < lines.length && !/^##\s+/.test(lines[index].trim())) {
    index += 1;
  }
  return lines.slice(index).join('\n').trim();
}

function parseTopLevelSectionsInOrder(text) {
  const sections = [];
  let current = null;
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      current = { heading: heading[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  return sections.map((section) => ({
    heading: section.heading,
    body: section.lines.join('\n').trim(),
  }));
}

function findExistingSectionMatch(sections, desiredHeading, aliases = []) {
  const candidates = new Set([desiredHeading, ...aliases].map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean));
  return sections.findIndex((section) => candidates.has(section.heading.toLowerCase()));
}

function composeManagedSectionedNote({ existingText = '', frontmatter, title, preambleLines = [], sections = [], appendUnknownSections = true, ignoredHeadings = [] }) {
  const existingSections = parseTopLevelSectionsInOrder(stripManagedHeadingBlock(existingText));
  const used = new Set();
  const ignored = new Set((ignoredHeadings ?? []).map((heading) => String(heading ?? '').trim().toLowerCase()).filter(Boolean));
  const lines = [frontmatter, title, ''];

  if (preambleLines.length > 0) {
    lines.push(...preambleLines, '');
  }

  for (const section of sections) {
    const matchIndex = findExistingSectionMatch(existingSections, section.heading, section.aliases ?? []);
    const content = matchIndex >= 0 && String(existingSections[matchIndex].body ?? '').trim()
      ? existingSections[matchIndex].body
      : section.content;
    if (matchIndex >= 0) {
      used.add(matchIndex);
    }
    lines.push(`## ${section.heading}`);
    lines.push(String(content ?? '').trim() || String(section.content ?? '').trim());
    lines.push('');
  }

  if (appendUnknownSections) {
    for (let index = 0; index < existingSections.length; index += 1) {
      if (used.has(index)) {
        continue;
      }
      const section = existingSections[index];
      if (ignored.has(section.heading.toLowerCase()) || !String(section.body ?? '').trim()) {
        continue;
      }
      lines.push(`## ${section.heading}`);
      lines.push(section.body.trim());
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function buildProjectOverviewLink(projectName, { label = projectName, noteType = 'overview' } = {}) {
  return `[[01_Projects/${projectName}/${noteType}|${label}]]`;
}

function buildKnowledgeNoteLink(noteType, label) {
  const fileName = noteType === 'documentation-style-patterns'
    ? 'documentation-style-patterns'
    : 'reusable-patterns';
  const linkLabel = label ?? (fileName === 'documentation-style-patterns' ? 'Documentation Style Patterns' : 'Reusable Patterns');
  return `[[04_Knowledge_Base/${fileName}|${linkLabel}]]`;
}

function buildProjectNoteFrontmatter(project, noteType) {
  const projectStatus = inferProjectStatus(project);
  const confidence = inferProjectConfidence(project);
  return renderManagedFrontmatter({
    type: noteType,
    project: project.name,
    ...(noteType === 'project-overview' ? { status: projectStatus } : {}),
    confidence,
    managed_by: MANAGED_BY,
    updated: resolveProjectUpdatedDate(project),
  });
}

function buildGlobalNoteFrontmatter(noteType, { confidence = 'medium', updated = timestamp().slice(0, 10) } = {}) {
  return renderManagedFrontmatter({
    type: noteType,
    confidence,
    managed_by: MANAGED_BY,
    updated,
  });
}

function resolveProjectUpdatedDate(project) {
  return firstMeaningful(
    String(project.lastSyncedAt ?? '').slice(0, 10),
    String(project.lastScannedAt ?? '').slice(0, 10),
    String(project.lastEmbeddedAt ?? '').slice(0, 10),
    timestamp().slice(0, 10),
  );
}

function inferProjectConfidence(project) {
  const score = scoreProjectConfidence(project);
  if (score >= 6) {
    return 'high';
  }
  if (score >= 3) {
    return 'medium';
  }
  return 'low';
}

function inferProjectStatus(project) {
  const summary = `${firstMeaningful(project.summary, project.purpose, '')} ${(project.riskNotes ?? []).join(' ')}`.toLowerCase();
  if (/artifact archive|archive/i.test(summary) || /prod-files/i.test(project.name)) {
    return 'archive';
  }
  if (/reference repo|reference codebase|mirror|vendor fork/i.test(summary) || /^flutter$/i.test(project.name)) {
    return 'reference';
  }
  return 'active';
}

function normalizeExistingLearningsNote(project, existingText) {
  const normalizedBody = normalizeStableProjectLinks(stripManagedHeadingBlock(existingText), project.name);
  if (!normalizedBody) {
    return renderLearningsNote(project);
  }
  return [
    buildProjectNoteFrontmatter(project, 'project-learnings'),
    `# ${project.name} Learnings`,
    '',
    normalizedBody.trim(),
    '',
  ].join('\n');
}

function normalizeStableProjectLinks(text, projectName) {
  return String(text ?? '')
    .replace(new RegExp(`\\[\\[${escapeRegExp(projectName)}\\]\\]`, 'g'), buildProjectOverviewLink(projectName))
    .replace(new RegExp(`Project:\\s+\\[\\[${escapeRegExp(projectName)}\\]\\]`, 'g'), `Project: ${buildProjectOverviewLink(projectName)}`);
}

function renderOverviewNote(project, existingText = '') {
  return composeManagedSectionedNote({
    existingText,
    frontmatter: buildProjectNoteFrontmatter(project, 'project-overview'),
    title: `# ${project.name} Overview`,
    preambleLines: [
      `Related: ${buildProjectOverviewLink(project.name, { noteType: 'architecture', label: 'Architecture' })} · ${buildProjectOverviewLink(project.name, { noteType: 'learnings', label: 'Learnings' })} · ${buildProjectOverviewLink(project.name, { noteType: 'prompts', label: 'Prompts' })}`,
    ],
    sections: [
      {
        heading: 'Purpose',
        content: firstMeaningful(project.purpose, project.summary, `${project.name} needs a concise purpose note before broad changes.`),
      },
      {
        heading: 'Current Status',
        content: renderBulletList(buildCurrentStatus(project), 'Status confidence is still thin; verify the repo directly before broad changes.'),
      },
      {
        heading: 'Stack',
        content: renderBulletList(limitMeaningful(project.stack, 6), 'Stack evidence is still thin; confirm the primary runtime from source docs before broad changes.'),
      },
      {
        heading: 'Active Risks',
        content: renderBulletList(buildActiveRisks(project), 'No specific active risks were inferred. Treat that as low confidence, not as proof that risk is absent.'),
      },
      {
        heading: 'Recent Decisions',
        content: renderBulletList(buildRecentDecisions(project), 'No durable decisions were inferred yet. Open the architecture note and source docs before reshaping the system.'),
      },
      {
        heading: 'Do Not Break',
        aliases: ['Important Boundaries'],
        content: renderBulletList(buildImportantBoundaries(project), 'This repo does not yet have strong automated boundary notes. Treat it as lower confidence and open the source docs first.'),
      },
      {
        heading: 'Important Modules',
        content: renderBulletList(buildImportantModules(project), 'No strong module boundary was inferred; inspect the source tree directly before broad edits.'),
      },
      {
        heading: 'Next Safe Move',
        aliases: ['Change Guidance'],
        content: renderBulletList(buildChangeGuidance(project), 'Keep changes narrow and validate against the nearest tests, scripts, or documented workflow.'),
      },
      {
        heading: 'Key Commands',
        content: renderBulletList(buildKeyCommands(project), 'No explicit validation command was inferred; inspect tests, scripts, or operator docs before risky changes.'),
      },
      {
        heading: 'Related Patterns',
        content: renderBulletList(buildRelatedPatternLinks(project), `Start from ${buildKnowledgeNoteLink('reusable-patterns')} before inventing a new implementation pattern.`),
      },
    ],
  });
}

function renderArchitectureNote(project, existingText = '') {
  return composeManagedSectionedNote({
    existingText,
    frontmatter: buildProjectNoteFrontmatter(project, 'project-architecture'),
    title: `# ${project.name} Architecture`,
    preambleLines: [
      `Related: ${buildProjectOverviewLink(project.name, { label: 'Overview' })} · ${buildProjectOverviewLink(project.name, { noteType: 'learnings', label: 'Learnings' })} · ${buildKnowledgeNoteLink('reusable-patterns')}`,
    ],
    sections: [
      {
        heading: 'Core Structure',
        content: renderBulletList(limitMeaningful(project.architecture, 6), firstMeaningful(project.summary, `${project.name} does not yet have enough architectural evidence for a stronger note.`)),
      },
      {
        heading: 'Runtime Flow',
        content: renderNumberedList(buildRuntimeFlow(project), 'No explicit runtime flow was inferred. Start from the main entrypoints and validation surface.'),
      },
      {
        heading: 'Important Interfaces',
        content: renderBulletList(buildImportantInterfaces(project), 'No strong interface surface was inferred beyond the main repository structure.'),
      },
      {
        heading: 'Current Decisions',
        content: renderBulletList(buildRecentDecisions(project), 'No durable design decisions were inferred yet. Use the overview and learnings notes to confirm the intended boundary.'),
      },
      {
        heading: 'Active Risks',
        content: renderBulletList(buildActiveRisks(project), 'No specific architectural risks were inferred. Verify assumptions from docs, tests, and scripts before broad changes.'),
      },
      {
        heading: 'Validation Surfaces',
        content: renderBulletList(buildValidationSurfaces(project), 'No explicit validation surface was inferred; inspect tests, scripts, or operator docs before broad changes.'),
      },
      {
        heading: 'Architectural Constraints',
        content: renderBulletList(buildArchitecturalConstraints(project), 'There are no strong inferred constraints yet; verify assumptions from docs, tests, and scripts.'),
      },
      {
        heading: 'Safe Extension Points',
        content: renderBulletList(buildSafeExtensionPoints(project), 'Prefer the smallest existing module boundary rather than introducing a new top-level surface.'),
      },
      {
        heading: 'Related Patterns',
        content: renderBulletList(buildRelatedPatternLinks(project), `Start from ${buildKnowledgeNoteLink('reusable-patterns')} before adding a new architectural rule.`),
      },
    ],
  });
}

function renderLearningsNote(project) {
  const learnings = buildStructuredLearnings(project);
  if (learnings.length === 0) {
    return [
      buildProjectNoteFrontmatter(project, 'project-learnings'),
      `# ${project.name} Learnings`,
      '',
      'This repo does not yet have enough evidence for durable autogenerated learnings. Use the overview, architecture, prompts, and source docs before broad changes.',
      '',
      '## Capture Rule',
      '- Promote a learning only when there was a real problem, a real fix, and a reusable lesson.',
      '- Skip generic repo summaries, dependency dumps, and obvious observations.',
      '',
    ].join('\n');
  }

  const sections = [buildProjectNoteFrontmatter(project, 'project-learnings'), `# ${project.name} Learnings`, ''];
  for (const [index, learning] of learnings.entries()) {
    sections.push(`## ${index + 1}. ${learning.title}`);
    sections.push('');
    sections.push('**Problem**');
    sections.push(learning.problem);
    sections.push('');
    sections.push('**Context**');
    sections.push(learning.context);
    sections.push('');
    sections.push('**Solution**');
    sections.push(learning.solution);
    sections.push('');
    sections.push('**Why it worked**');
    sections.push(learning.whyItWorked);
    sections.push('');
    sections.push('**Reusable Pattern**');
    sections.push(learning.reusablePattern);
    sections.push('');
    sections.push('**Confidence**');
    sections.push(`${learning.evidenceQuality} ${learning.confidence}`);
    sections.push('');
    sections.push('**Evidence**');
    sections.push(renderBulletParagraph(learning.supportingSources.map((source) => summarizeEvidenceSource(source, { includeExcerpt: true }))));
    sections.push('');
    sections.push('**Follow-up**');
    sections.push(learning.followUp);
    sections.push('');
  }
  return `${sections.join('\n').trimEnd()}\n`;
}

function renderPromptsNote(project, existingText = '') {
  const modulePreview = buildImportantModules(project).slice(0, 4).join(', ');
  const boundaryPreview = buildImportantBoundaries(project).slice(0, 2).join('; ');
  const debugSurface = buildImportantInterfaces(project).slice(0, 3).join(', ');
  const validationPreview = buildValidationSurfaces(project).slice(0, 3).join('; ');

  return composeManagedSectionedNote({
    existingText,
    frontmatter: buildProjectNoteFrontmatter(project, 'project-prompts'),
    title: `# ${project.name} Prompts`,
    preambleLines: [
      `Related: ${buildProjectOverviewLink(project.name)} · ${buildProjectOverviewLink(project.name, { noteType: 'architecture', label: 'Architecture' })} · ${buildKnowledgeNoteLink('reusable-patterns')}`,
    ],
    sections: [
      {
        heading: 'Safe Change Prompt',
        content: `Work in \`${project.name}\` without breaking ${boundaryPreview || 'the repo’s current boundaries'}. Identify the smallest module boundary first${modulePreview ? `, likely among ${modulePreview}` : ''}, then name the command or validation surface that proves the change is safe${validationPreview ? `, such as ${validationPreview}` : ''}.`,
      },
      {
        heading: 'Boundary Recall Prompt',
        content: `Before a non-trivial edit in \`${project.name}\`, summarize the relevant modules, important interfaces, active risks, and operator boundaries from the notes and source files instead of starting from a stack overview.`,
      },
      {
        heading: 'Debugging Prompt',
        content: `Trace the issue through ${debugSurface || 'the main entrypoint, tests, and docs'} before changing surrounding code or UI copy. Name the failure mode and the nearest validation path${validationPreview ? `, likely among ${validationPreview}` : ''}.`,
      },
      {
        heading: 'Dangerous Change Prompt',
        content: `Label destructive or stateful work explicitly before you start. Call out the backup path, the runtime boundary at risk, and the exact validation step you will run before changing deletes, migrations, retries, state resets, or deploy logic in \`${project.name}\`.`,
      },
      {
        heading: 'Post-Fix Learning Prompt',
        content: 'Capture a learning only if the work produced a real reusable guardrail, workflow improvement, or failure-mode fix. Skip cosmetic edits and obvious observations.',
      },
    ],
  });
}

function renderReusablePatternsTemplate() {
  return [
    buildGlobalNoteFrontmatter('reusable-patterns', { confidence: 'medium' }),
    '# Reusable Patterns',
    '',
    'Use this note as the main pattern library for real implementation work. Every pattern here should be concrete, evidence-backed, and tied to an actual boundary or failure mode.',
    '',
    'For repo-facing documentation and README composition patterns, use [[04_Knowledge_Base/documentation-style-patterns|Documentation Style Patterns]].',
    '',
    'Pattern fields to keep stable when you add a new entry: Proven In, When To Use, When Not To Use, Failure Mode, Validation, and Related Projects.',
    '',
    'Add or rewrite patterns manually when the same boundary, workaround, or guardrail proves useful across more than one repo.',
  ].join('\n');
}

function renderDocumentationStylePatternsSeed() {
  return [
    buildGlobalNoteFrontmatter('documentation-style-patterns', { confidence: 'medium' }),
    '# Documentation Style Patterns',
    '',
    'Use this note to capture repo-facing documentation patterns grounded in strong local repositories.',
    '',
    '- Prefer README structure, architecture-document rhythm, operator-guide layout, and agent-instruction patterns over generic writing advice.',
    '- Promote only patterns that are visible in real repositories and reusable across more than one repo.',
  ].join('\n');
}

function renderDebuggingInsightsTemplate() {
  return [
    buildGlobalNoteFrontmatter('debugging-insights', { confidence: 'medium' }),
    '# Debugging Insights',
    '',
    'Capture only the debugging observations that are likely to save future work.',
    '',
    '## What repeatedly helps',
    '- Name the failure mode, the boundary at risk, and the validation command instead of restating repo structure.',
    '- Prefer concrete operator guardrails, rollout lessons, and workflow fixes over generic architecture commentary.',
    '',
    '## Capture rule',
    '- If a bug fix required a precise command, workflow guardrail, or environment caveat, record it.',
    '- If it only required reading the README carefully, do not promote it.',
  ].join('\n');
}

function renderAgentWorkflowNotesTemplate() {
  return [
    buildGlobalNoteFrontmatter('agent-workflow-notes', { confidence: 'medium' }),
    '# Agent Workflow Notes',
    '',
    'Use the vault to narrow the search space, not to replace source inspection.',
    '',
    '## Default workflow',
    '1. Read the project overview to understand purpose, boundaries, and safe change guidance.',
    '2. Read the learnings note to see whether a similar bug, contract, or workflow was solved before.',
    '3. Check [[04_Knowledge_Base/reusable-patterns|Reusable Patterns]] for implementation work or [[04_Knowledge_Base/documentation-style-patterns|Documentation Style Patterns]] for repo-facing documentation work.',
    '4. Open the source repo docs, tests, or scripts named in the notes before making a non-trivial change.',
    '5. Capture a new learning only if the work produced a durable fix or reusable guardrail.',
  ].join('\n');
}

function renderResearchCandidatesTemplate() {
  return [
    buildGlobalNoteFrontmatter('research-candidates', { confidence: 'low' }),
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
}

function renderSystemArchitectureNote(config) {
  return [
    buildGlobalNoteFrontmatter('system-architecture', { confidence: 'high' }),
    '# AI Brain Architecture',
    '',
    'This vault exists to preserve engineering memory, not to mirror repositories or host runtime state.',
    '',
    '## Mental model',
    '- Source repos are read-only evidence.',
    '- Project notes are the human-readable memory layer.',
    '- Documentation style patterns are first-class reusable knowledge for README, architecture, operator, and agent surfaces.',
    '- Embeddings and retrieval are the recall layer.',
    '- MCP is the delivery layer that lets agents consult the memory during real work.',
    '',
    '## Primary flow',
    '1. Read high-signal repo surfaces such as README files, handoff notes, tests, scripts, and architecture docs.',
    '2. Distill that evidence into short project notes, durable learnings, reusable implementation patterns, and reusable documentation-style patterns.',
    '3. Embed the curated notes for retrieval.',
    '4. Use retrieval to narrow the search space before opening source files.',
    '',
    '## Boundaries that matter',
    '- Source repos are inputs. They are not rewritten from the vault.',
    `- The vault is knowledge only. Runtime data belongs under ${config.dataRoot.replace(config.brainRoot, 'data')} and not inside the vault.`,
    '- Project notes should summarize decisions, boundaries, failure modes, and reuse value. They should not be README mirrors.',
  ].join('\n');
}

function renderOperationsNote() {
  return [
    buildGlobalNoteFrontmatter('system-operations', { confidence: 'high' }),
    '# Operations',
    '',
    'This note defines how the vault should be maintained as a knowledge system.',
    '',
    '## Promotion rules',
    '- Promote a note into project learnings only when there was a real problem, a real fix, and a reusable lesson.',
    '- Promote a note into the knowledge base only when it clearly applies across more than one repo.',
    '- Promote repo-facing documentation patterns only when they are visible in strong local repositories and specific enough to reuse later.',
    '- Keep setup trivia, dependency dumps, sync output, raw query transcripts, and runtime artifacts out of both places.',
    '',
    '## Rewrite rules',
    '- Prefer fewer strong notes over many weak ones.',
    '- If a repo lacks evidence, say so directly instead of inventing maturity.',
    '- Remove deprecated note shapes instead of preserving compatibility with weak old output.',
  ].join('\n');
}

function renderRetrievalNote() {
  return [
    buildGlobalNoteFrontmatter('system-retrieval', { confidence: 'high' }),
    '# Retrieval',
    '',
    'Good retrieval depends more on note quality and query shape than on embedding volume.',
    '',
    '## Retrieval priority',
    '1. Current project overview and learnings.',
    '2. Cross-project implementation patterns and documentation-style patterns that match the same boundary, workflow, or repo surface.',
    '3. Recent learnings only when they contain an actual workaround, guardrail, or workflow win.',
    '',
    '## Tuning rule',
    'If a repeated query shape keeps returning useful context, promote that wording into the project prompts note or into the curated sections of [[03_Agent_Notes/query-history|Query History]]. Raw transcripts stay in runtime state.',
  ].join('\n');
}

function renderProjectIndexNote(projects) {
  const grouped = groupProjectsByConfidence(projects);
  const sections = [
    '# Project Index',
    '',
    'Use this note to navigate the portfolio quickly and calibrate confidence before changing a repo.',
    '',
    '## High-confidence projects',
    renderProjectSummaryList(grouped.high, 'No projects currently meet the high-confidence threshold.'),
    '',
    '## Medium-confidence projects',
    renderProjectSummaryList(grouped.medium, 'No projects currently sit in the medium-confidence band.'),
    '',
    '## Low-confidence or special-case projects',
    renderProjectSummaryList(grouped.low, 'No low-confidence or special-case projects are currently flagged.'),
    '',
    'Start with the project overview, then the learnings note, then [[04_Knowledge_Base/reusable-patterns|Reusable Patterns]] for implementation work or [[04_Knowledge_Base/documentation-style-patterns|Documentation Style Patterns]] for repo-facing documentation work.',
  ];
  return sections.join('\n');
}

function renderPortfolioSummaryNote(projects) {
  const grouped = groupProjectsByConfidence(projects);
  return [
    '# Portfolio Summary',
    '',
    'This vault aims to answer three questions quickly: what the project is, what boundaries matter, and what prior learning is reusable.',
    '',
    '## Strongest coverage',
    renderBulletList(grouped.high.map((project) => `${project.name}: ${truncate(project.purpose ?? project.summary ?? '', 140)}`), 'No repos currently have strong enough note coverage to be grouped here.'),
    '',
    '## Medium coverage',
    renderBulletList(grouped.medium.map((project) => `${project.name}: ${truncate(project.purpose ?? project.summary ?? '', 140)}`), 'No repos currently sit in the medium-coverage band.'),
    '',
    '## Weak coverage',
    renderBulletList(grouped.low.map((project) => `${project.name}: ${truncate(project.riskNotes?.[0] ?? project.summary ?? '', 140)}`), 'No repos are currently flagged as weak coverage.'),
    '',
    '## Highest-value reusable areas',
    renderBulletList(uniqueStrings(projects.flatMap((project) => limitMeaningful(project.reusableSolutions, 1))).slice(0, 6), 'No cross-project reusable areas have been distilled yet.'),
  ].join('\n');
}

function renderDocumentationStylePatternsNote(projects) {
  const benchmarkProjects = [...projects]
    .filter((project) => (project.documentationPatterns?.length ?? 0) > 0)
    .sort((left, right) => (right.documentationQualityScore ?? 0) - (left.documentationQualityScore ?? 0) || (right.documentationQualitySignals?.length ?? 0) - (left.documentationQualitySignals?.length ?? 0))
    .slice(0, 6);
  const catalog = buildDocumentationPatternCatalog(projects);
  const lines = [
    '# Documentation Style Patterns',
    '',
    'Use this note when shaping a repository README, architecture doc, operator guide, or agent instruction surface. These patterns are distilled from repositories with strong documentation signals in the local project set.',
    '',
    '## What belongs here',
    '- README opening sequence and GitHub cover composition.',
    '- Architecture-document rhythm, diagram placement, and operator-guide structure.',
    '- Agent-instruction layout and boundary-explanation patterns.',
    '- Repo-facing documentation techniques grounded in strong local repositories rather than generic writing advice.',
    '',
    '## Strong benchmark repos',
    renderBulletList(benchmarkProjects.map((project) => `${project.name}: score ${project.documentationQualityScore ?? 0} | ${firstMeaningful(project.documentationQualitySignals?.[0], project.documentationPatterns?.[0], project.purpose)}`), 'No benchmark repos have strong documentation signals yet.'),
    '',
    '## Reusable patterns',
  ];

  if (catalog.length === 0) {
    lines.push('- No reusable documentation-style patterns have been distilled yet.');
    return lines.join('\n');
  }

  for (const entry of catalog.slice(0, 10)) {
    lines.push(`### ${documentationPatternHeading(entry.pattern)}`);
    lines.push('');
    lines.push(`- Pattern: ${entry.pattern}`);
    lines.push(`- Seen in: ${entry.sourceProjects.join(', ')}`);
    lines.push(`- Confidence: ${entry.evidenceQuality} ${entry.confidence}`);
    if (entry.evidencePaths.length > 0) {
      lines.push(`- Evidence: ${entry.evidencePaths.join(' | ')}`);
    }
    if (entry.supportingEvidence.length > 0) {
      lines.push(`- Supporting excerpt: ${summarizeEvidenceSource(entry.supportingEvidence[0], { includeExcerpt: true })}`);
    }
    if (entry.qualitySignals.length > 0) {
      lines.push(`- Why it stands out: ${entry.qualitySignals.slice(0, 2).join(' ')}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function buildDocumentationPatternCatalog(projects) {
  const catalog = new Map();
  for (const project of projects) {
    const documentationPatternRecords = (project.provenance?.documentationPatterns ?? []).length > 0
      ? project.provenance.documentationPatterns
      : (project.documentationPatterns ?? []).map((value) => ({ value, sources: [], evidenceQuality: 'weak', confidence: 0.48 }));
    for (const patternRecord of documentationPatternRecords) {
      const pattern = patternRecord?.value ?? '';
      const entry = catalog.get(pattern) ?? {
        pattern,
        sourceProjects: [],
        evidencePaths: [],
        qualitySignals: [],
        supportingEvidence: [],
        evidenceQuality: patternRecord?.evidenceQuality ?? 'weak',
        confidence: Number(patternRecord?.confidence ?? 0),
      };
      entry.sourceProjects = uniqueStrings([...entry.sourceProjects, project.name]);
      entry.evidencePaths = uniqueStrings([...entry.evidencePaths, ...buildDocumentationEvidencePaths(project)]).slice(0, 4);
      entry.qualitySignals = uniqueStrings([...entry.qualitySignals, ...(project.documentationQualitySignals ?? []).slice(0, 2)]).slice(0, 4);
      entry.supportingEvidence = mergeSupportingEvidence(entry.supportingEvidence, patternRecord?.sources ?? []);
      entry.evidenceQuality = strongerEvidenceQuality(entry.evidenceQuality, patternRecord?.evidenceQuality ?? 'weak');
      entry.confidence = Number(Math.max(entry.confidence, Number(patternRecord?.confidence ?? 0)).toFixed(4));
      catalog.set(pattern, entry);
    }
  }

  return [...catalog.values()]
    .sort((left, right) => right.sourceProjects.length - left.sourceProjects.length || right.qualitySignals.length - left.qualitySignals.length || left.pattern.localeCompare(right.pattern));
}

function buildDocumentationEvidencePaths(project) {
  const preferredPaths = (project.documentationPaths ?? []).filter((relativePath) => /(?:^|\/)(README\.md|ARCHITECTURE\.md|TROUBLESHOOTING\.md|AGENTS\.md|CLAUDE\.md|copilot-instructions\.md)$/i.test(relativePath));
  const fallbackPaths = preferredPaths.length > 0 ? preferredPaths : (project.documentationPaths ?? []).slice(0, 3);
  return uniqueStrings(fallbackPaths.map((relativePath) => `${project.name}/${relativePath}`)).slice(0, 4);
}

function documentationPatternHeading(pattern) {
  const normalized = normalizeLine(pattern);
  if (!normalized) {
    return 'Documentation pattern';
  }
  const [heading] = normalized.split(':');
  return truncate(heading || normalized, 72);
}

function renderQueryHistoryNote(existingText = '') {
  const manualSections = parseTopLevelSections(stripLegacyManagedSections(stripFrontmatter(existingText)));

  return composeManagedSectionedNote({
    existingText,
    frontmatter: buildGlobalNoteFrontmatter('agent-query-history', { confidence: 'medium' }),
    title: '# Query History',
    preambleLines: [
      'Keep this note short and curated. Raw query and consultation telemetry lives in `data/state/brain-state.json`, not in the vault.',
    ],
    appendUnknownSections: false,
    ignoredHeadings: [
      'Recent Queries',
      'Projects Recalled Most Often',
      'Strong retrieval topics',
      'Weak retrieval topics',
      'Query hygiene',
    ],
    sections: [
      {
        heading: 'Useful Query Patterns',
        content: mergeQueryHistorySections(manualSections, ['Useful Query Patterns', 'Query shapes that work well', 'Reusable query patterns'], DEFAULT_QUERY_HISTORY_SECTIONS.usefulPatterns).join('\n'),
      },
      {
        heading: 'What Belongs Here',
        content: mergeQueryHistorySections(manualSections, ['What Belongs Here'], DEFAULT_QUERY_HISTORY_SECTIONS.whatBelongsHere).join('\n'),
      },
      {
        heading: 'What Stays In Runtime State',
        content: mergeQueryHistorySections(manualSections, ['What Stays In Runtime State', 'What stays out of this note'], DEFAULT_QUERY_HISTORY_SECTIONS.runtimeStateOnly).join('\n'),
      },
      {
        heading: 'Promotion Criteria',
        content: mergeQueryHistorySections(manualSections, ['Promotion Criteria', 'Promotion rule'], DEFAULT_QUERY_HISTORY_SECTIONS.promotionCriteria).join('\n'),
      },
      {
        heading: 'Last Curated',
        content: mergeQueryHistorySections(manualSections, ['Last Curated'], DEFAULT_QUERY_HISTORY_SECTIONS.lastCurated).join('\n'),
      },
    ],
  });
}

function parseTopLevelSections(text) {
  const sections = {};
  let currentSection = null;
  for (const rawLine of String(text ?? '').split('\n')) {
    const heading = rawLine.trim().match(/^##\s+(.+)$/);
    if (heading) {
      currentSection = heading[1].trim();
      sections[currentSection] = [];
      continue;
    }
    if (currentSection) {
      sections[currentSection].push(rawLine.trimEnd());
    }
  }
  return Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.join('\n').trim()]));
}

function pickQueryHistorySection(sections, name, fallbackLines) {
  const existing = String(sections[name] ?? '').trim();
  if (!existing) {
    return fallbackLines;
  }

  const lines = existing
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  return lines.length > 0 ? lines : fallbackLines;
}

function mergeQueryHistorySections(sections, names, fallbackLines) {
  const merged = [];
  for (const name of names) {
    const existing = String(sections[name] ?? '').trim();
    if (!existing) {
      continue;
    }
    for (const line of existing.split('\n').map((value) => value.trimEnd()).filter((value) => value.trim().length > 0)) {
      merged.push(line);
    }
  }
  return merged.length > 0 ? uniqueStrings(merged) : fallbackLines;
}

function buildImportantBoundaries(project) {
  return limitMeaningful(uniqueStrings([
    ...(project.boundaryRules ?? []),
    ...project.architecture,
    ...project.riskNotes,
    ...project.workflows.filter((workflow) => /docs-as-code|verification surface|scriptable|read-only|local/i.test(workflow)),
  ]), 5);
}

function buildImportantModules(project) {
  return limitMeaningful(uniqueStrings([
    ...(project.modules ?? []).slice(0, 8),
    ...(project.entryPoints ?? []).slice(0, 4),
  ]), 6);
}

function buildChangeGuidance(project) {
  const modules = buildImportantModules(project).slice(0, 3).join(', ');
  return limitMeaningful(uniqueStrings([
    modules ? `Change the smallest relevant boundary first, likely among: ${modules}.` : '',
    ...buildValidationSurfaces(project).slice(0, 2).map((surface) => `Validate with: ${surface}.`),
    project.documentationPaths?.length ? `Open the nearest docs first: ${project.documentationPaths.slice(0, 2).join(', ')}.` : '',
    project.entryPoints?.length ? `Validate from the real entry surface: ${project.entryPoints.slice(0, 2).join(', ')}.` : '',
    project.riskNotes?.find((risk) => !/No elevated structural risks/i.test(risk)) ?? '',
  ]), 4);
}

function buildCurrentStatus(project) {
  return limitMeaningful(uniqueStrings([
    `Repo posture: ${inferProjectStatus(project)}.`,
    `Knowledge confidence: ${inferProjectConfidence(project)}.`,
    project.summary ? `Snapshot: ${project.summary}` : '',
    buildValidationSurfaces(project)[0] ? `Nearest validation surface: ${buildValidationSurfaces(project)[0]}.` : '',
  ]), 4);
}

function buildActiveRisks(project) {
  return limitMeaningful((project.riskNotes ?? [])
    .filter((risk) => !/no elevated structural risks were inferred/i.test(String(risk ?? ''))), 5);
}

function buildRecentDecisions(project) {
  const learningTitles = buildStructuredLearnings(project).slice(0, 3).map((learning) => learning.title);
  return limitMeaningful(uniqueStrings([
    ...learningTitles,
    ...(project.reusableSolutions ?? []).slice(0, 2),
  ]), 4);
}

function buildKeyCommands(project) {
  return limitMeaningful(uniqueStrings([
    ...buildValidationSurfaces(project),
    ...(project.entryPoints ?? []).slice(0, 2).map((entryPoint) => `Open the real entry surface first: ${entryPoint}.`),
  ]), 5);
}

function buildRelatedPatternLinks(project) {
  return limitMeaningful(uniqueStrings([
    buildKnowledgeNoteLink('reusable-patterns'),
    project.documentationPaths?.length ? buildKnowledgeNoteLink('documentation-style-patterns') : '',
    buildProjectOverviewLink(project.name, { noteType: 'learnings', label: `${project.name} learnings` }),
  ]), 3);
}

function buildRuntimeFlow(project) {
  return limitMeaningful(uniqueStrings([
    ...project.workflows,
    ...(project.entryPoints ?? []).slice(0, 3).map((entryPoint) => `Execution enters through ${entryPoint}.`),
    ...(project.integrationSurfaces ?? []).slice(0, 2),
  ]), 5);
}

function buildImportantInterfaces(project) {
  return limitMeaningful(uniqueStrings([
    ...(project.entryPoints ?? []).slice(0, 5).map((entryPoint) => `Entrypoint: ${entryPoint}`),
    ...(project.integrationSurfaces ?? []).slice(0, 5),
    ...buildValidationSurfaces(project).slice(0, 3).map((surface) => `Validation: ${surface}`),
    ...(project.documentationPaths ?? []).slice(0, 3).map((docPath) => `Doc: ${docPath}`),
  ]), 6);
}

function buildArchitecturalConstraints(project) {
  return limitMeaningful(uniqueStrings([
    ...(project.boundaryRules ?? []),
    ...project.riskNotes,
    ...(project.architecture ?? []).filter((pattern) => /boundary|state|offline|docs-as-code|local|operator|workflow/i.test(pattern)),
  ]), 5);
}

function buildValidationSurfaces(project) {
  return limitMeaningful(uniqueStrings([
    ...(project.validationSurfaces ?? []),
    ...(project.workflows ?? []).filter((workflow) => /verification surface|tests|specs/i.test(workflow)),
  ]), 6);
}

function buildSafeExtensionPoints(project) {
  return limitMeaningful(uniqueStrings([
    ...(project.improvementIdeas ?? []).map((idea) => normalizeExtensionIdea(idea)),
    ...buildImportantModules(project).slice(0, 3).map((moduleName) => `Prefer extending the existing ${moduleName} surface before adding a new top-level area.`),
  ]), 4);
}

function buildStructuredLearnings(project) {
  const evidencePoints = (project.boundaryRules?.length ?? 0) + (project.validationSurfaces?.length ?? 0) + ((project.documentationQualityScore ?? 0) >= 6 ? 1 : 0);
  if (evidencePoints < 2) {
    return [];
  }

  const problems = limitMeaningful(project.recurringProblems, 3)
    .filter((problem) => !/artifact archive|reference fork/i.test(problem))
    .filter(isHighSignalLearningProblem);
  const solutions = limitMeaningful(uniqueStrings([
    ...(project.boundaryRules ?? []),
    ...(project.reusableSolutions ?? []),
  ]), 5).filter(isHighSignalLearningSolution);
  if (problems.length === 0 || solutions.length === 0) {
    return [];
  }

  const learnings = [];
  for (let index = 0; index < Math.min(problems.length, solutions.length, 2); index += 1) {
    const problem = problems[index] ?? problems[0];
    const solution = solutions[index] ?? solutions[0];
    if (!isMeaningful(problem) || !isMeaningful(solution)) {
      continue;
    }
    learnings.push({
      title: learningTitle(solution, problem),
      problem,
      context: renderBulletParagraph(limitMeaningful(uniqueStrings([
        `Purpose: ${firstMeaningful(project.purpose, project.summary, project.name)}`,
        project.stack?.length ? `Stack: ${project.stack.slice(0, 6).join(', ')}` : '',
        project.architecture?.length ? `Architecture: ${project.architecture.slice(0, 3).join('; ')}` : '',
        project.boundaryRules?.length ? `Key boundaries: ${project.boundaryRules.slice(0, 3).join('; ')}` : '',
        buildValidationSurfaces(project).length ? `Validation: ${buildValidationSurfaces(project).slice(0, 3).join('; ')}` : '',
        buildImportantModules(project).length ? `Key surfaces: ${buildImportantModules(project).slice(0, 5).join(', ')}` : '',
      ]), 4)),
      solution,
      whyItWorked: firstMeaningful(project.boundaryRules?.[0], project.architecture?.[0], project.workflows?.[0], 'The repo exposes enough structure to repeat the same solution safely.'),
      reusablePattern: firstMeaningful(project.reusableSolutions?.[index], solution),
      ...buildLearningEvidence(project, problem, solution),
      followUp: firstMeaningful(buildValidationSurfaces(project)[0], limitMeaningful(project.improvementIdeas, 1)[0], 'Validate the pattern again before promoting it further.'),
    });
  }
  return learnings;
}

function buildLearningEvidence(project, problem, solution) {
  const candidates = pickTopEvidenceItems([
    ...matchEvidenceItems(project.provenance?.recurringProblems ?? [], problem),
    ...matchEvidenceItems(project.provenance?.reusableSolutions ?? [], solution),
    ...pickTopEvidenceItems(project.provenance?.boundaryRules ?? [], 1),
    ...pickTopEvidenceItems(project.provenance?.validationSurfaces ?? [], 1),
  ], 3);

  return {
    evidenceQuality: maxEvidenceQuality(candidates),
    confidence: Number(maxEvidenceConfidence(candidates).toFixed(4)),
    supportingSources: mergeSupportingEvidence([], candidates.flatMap((item) => item.sources ?? [])),
  };
}

function matchEvidenceItems(items, value) {
  const normalizedValue = normalizeLine(value).toLowerCase();
  return (items ?? []).filter((item) => {
    const candidate = normalizeLine(item.value).toLowerCase();
    return candidate === normalizedValue || candidate.includes(normalizedValue) || normalizedValue.includes(candidate);
  });
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
  return [...keyed.values()].slice(0, 4);
}

function strongerEvidenceQuality(left, right) {
  const rank = { weak: 1, medium: 2, strong: 3 };
  return (rank[right] ?? 0) > (rank[left] ?? 0) ? right : left;
}

function isHighSignalLearningProblem(value) {
  const normalized = normalizeLine(value).toLowerCase();
  return isMeaningful(value) && /(read-only|local-first|runtime state|vault|repo-local|global state|artifact|evidence|boundary|contract|constraint|deterministic|snapshot|rewind|operator|secret|without|instead of|must|avoid|keep|preserve|limit|only)/i.test(normalized);
}

function isHighSignalLearningSolution(value) {
  const normalized = normalizeLine(value).toLowerCase();
  if (!isMeaningful(value)) {
    return false;
  }
  return !/capture repeatable implementation decisions in dedicated notes/i.test(normalized);
}

function groupProjectsByConfidence(projects) {
  const grouped = { high: [], medium: [], low: [] };
  for (const project of [...projects].sort((left, right) => left.name.localeCompare(right.name))) {
    const score = scoreProjectConfidence(project);
    if (score >= 6) {
      grouped.high.push(project);
    } else if (score >= 3) {
      grouped.medium.push(project);
    } else {
      grouped.low.push(project);
    }
  }
  return grouped;
}

function scoreProjectConfidence(project) {
  let score = 0;
  score += limitMeaningful(project.documentationPaths, 4).length >= 2 ? 2 : 0;
  score += project.entryPoints?.length ? 1 : 0;
  score += limitMeaningful(project.architecture, 4).length >= 2 ? 1 : 0;
  score += limitMeaningful(project.reusableSolutions, 4).length >= 1 ? 2 : 0;
  score += project.workflows?.some((workflow) => /verification surface|tests|scriptable/i.test(workflow)) ? 1 : 0;
  score -= project.riskNotes?.some((risk) => /artifact archive|reference fork|lacks clear documentation/i.test(risk)) ? 2 : 0;
  score -= limitMeaningful(project.documentationPaths, 4).length === 0 ? 1 : 0;
  return score;
}

function renderProjectSummaryList(projects, fallback) {
  if (projects.length === 0) {
    return fallback;
  }
  return projects.map((project) => `- [[01_Projects/${project.name}/overview|${project.name}]]: ${truncate(firstMeaningful(project.purpose, project.summary, project.name), 140)}`).join('\n');
}

function renderBulletList(items, fallback) {
  const meaningful = limitMeaningful(items, 8);
  if (meaningful.length === 0) {
    return `- ${fallback}`;
  }
  return meaningful.map((item) => `- ${item}`).join('\n');
}

function renderNumberedList(items, fallback) {
  const meaningful = limitMeaningful(items, 6);
  if (meaningful.length === 0) {
    return `1. ${fallback}`;
  }
  return meaningful.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function renderBulletParagraph(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function limitMeaningful(items, limit) {
  return uniqueStrings((items ?? []).map((item) => normalizeLine(item)).filter(isMeaningful)).slice(0, limit);
}

function firstMeaningful(...values) {
  for (const value of values.flat()) {
    const normalized = normalizeLine(value);
    if (isMeaningful(normalized)) {
      return normalized;
    }
  }
  return '';
}

function normalizeLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isMeaningful(value) {
  const normalized = normalizeLine(value);
  if (!normalized) {
    return false;
  }
  return !/locally indexed software project tracked inside the ai brain vault|no elevated structural risks were inferred|no explicit workflow surface was detected|no strong integration surfaces were inferred|no immediate follow-up improvements were inferred|no package dependencies were captured|no common entrypoint files were detected|no readme or docs paths were detected|indexing warnings/i.test(normalized.toLowerCase());
}

function learningTitle(solution, problem) {
  const cleaned = normalizeLine(solution).replace(/[.]+$/, '');
  if (cleaned.length <= 72) {
    return cleaned;
  }
  const problemPrefix = normalizeLine(problem).split(/[.;:]/)[0];
  return truncate(problemPrefix || cleaned, 72);
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeExtensionIdea(value) {
  const normalized = normalizeLine(value);
  if (!normalized) {
    return '';
  }
  if (/^add |^document |^capture /i.test(normalized)) {
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  return normalized;
}

function contentHashishEqual(left, right) {
  return stripLegacyManagedSections(left).trim() === stripLegacyManagedSections(right).trim();
}

function preserveCanonicalStaticContent(existing, fallbackContent) {
  const cleaned = stripLegacyManagedSections(existing).trim();
  if (!cleaned) {
    return fallbackContent;
  }
  return cleaned;
}

async function createLocalRunner(config) {
  const runnerPath = config.runnerPath;
  const mcpRunnerPath = config.mcpRunnerPath;
  const plistPath = config.launchdPlistPath;
  const stdoutLog = config.watchStdoutLogPath;
  const stderrLog = config.watchStderrLogPath;
  const nodeBinary = process.execPath;
  await fs.mkdir(config.runtimeAssetsRoot, { recursive: true });

  await fs.writeFile(runnerPath, [
    '#!/bin/zsh',
    'set -euo pipefail',
    '',
    `NODE_BINARY=${shellQuote(nodeBinary)}`,
    `SCRIPT_PATH=${shellQuote(config.runtimeScriptPath)}`,
    `BRAIN_ROOT=${shellQuote(config.brainRoot)}`,
    '',
    'cd "$BRAIN_ROOT"',
    'exec "$NODE_BINARY" "$SCRIPT_PATH" "$@"',
    '',
  ].join('\n'), 'utf8');
  await fs.chmod(runnerPath, 0o755);

  await fs.writeFile(mcpRunnerPath, [
    '#!/bin/zsh',
    'set -euo pipefail',
    '',
    `NODE_BINARY=${shellQuote(nodeBinary)}`,
    `BRAIN_ROOT=${shellQuote(config.brainRoot)}`,
    `MCP_SERVER_PATH=${shellQuote(path.join(config.brainRoot, 'apps', 'mcp-server', 'index.mjs'))}`,
    '',
    'cd "$BRAIN_ROOT"',
    'exec "$NODE_BINARY" "$MCP_SERVER_PATH" "$@"',
    '',
  ].join('\n'), 'utf8');
  await fs.chmod(mcpRunnerPath, 0o755);

  await fs.writeFile(plistPath, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>com.local.ai-brain</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/zsh</string>',
    '    <string>-lc</string>',
    `    <string>${escapeXml(`${runnerPath} watch --watch-mode native`)}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(stdoutLog)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(stderrLog)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n'), 'utf8');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
