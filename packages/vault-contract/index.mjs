import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, normalizeSlashes, uniqueStrings } from '../shared/index.mjs';

export const CANONICAL_PROJECT_NOTE_TYPES = ['overview', 'architecture', 'learnings', 'prompts'];
export const CANONICAL_PROJECT_NOTE_FILES = CANONICAL_PROJECT_NOTE_TYPES.map((noteType) => `${noteType}.md`);
export const DEPRECATED_PROJECT_NOTE_FILES = ['logs.md'];

export const CANONICAL_GLOBAL_NOTES = {
  projectIndex: path.join('01_Projects', '_Project_Index.md'),
  reusablePatterns: path.join('04_Knowledge_Base', 'reusable-patterns.md'),
  documentationStylePatterns: path.join('04_Knowledge_Base', 'documentation-style-patterns.md'),
  queryHistory: path.join('03_Agent_Notes', 'query-history.md'),
  debuggingInsights: path.join('03_Agent_Notes', 'debugging-insights.md'),
  agentWorkflowNotes: path.join('03_Agent_Notes', 'agent-workflow-notes.md'),
  researchCandidates: path.join('03_Agent_Notes', 'research-candidates.md'),
  portfolioSummary: path.join('06_Summaries', 'Portfolio_Summary.md'),
  architecture: path.join('99_System', 'AI_Brain_Architecture.md'),
  operations: path.join('99_System', 'Operations.md'),
  retrieval: path.join('99_System', 'Retrieval.md'),
};

export const OPTIONAL_GLOBAL_NOTES = new Set([
  CANONICAL_GLOBAL_NOTES.researchCandidates,
]);

export const CANONICAL_SYSTEM_FILES = new Set([
  'README.md',
  'AI_Brain_Architecture.md',
  'Operations.md',
  'Retrieval.md',
]);

export const CANONICAL_AGENT_NOTE_FILES = new Set([
  'README.md',
  'agent-workflow-notes.md',
  'debugging-insights.md',
  'query-history.md',
  'research-candidates.md',
]);

export const CANONICAL_KNOWLEDGE_BASE_FILES = new Set([
  'README.md',
  'reusable-patterns.md',
  'documentation-style-patterns.md',
]);

export function isCanonicalKnowledgeBasePath(value) {
  const normalized = normalizeSlashes(String(value ?? ''));
  const match = normalized.match(/04_Knowledge_Base\/([^/]+\.md)$/i);
  return Boolean(match?.[1] && CANONICAL_KNOWLEDGE_BASE_FILES.has(match[1]));
}

export const LEGACY_MARKERS = [
  '<!-- AI_BRAIN:GENERATED_START -->',
  '<!-- AI_BRAIN:GENERATED_END -->',
  '<!-- BRAIN:GENERATED_START -->',
  '<!-- BRAIN:GENERATED_END -->',
];

const RUNTIME_ARTIFACT_BASENAMES = new Set([
  'run-brain.sh',
  'run-brain-mcp.sh',
  'com.local.ai-brain.plist',
  'brain-state.json',
  'self-test-state.json',
  'chroma.sqlite3',
]);

const RUNTIME_ARTIFACT_EXTENSIONS = new Set(['.plist']);

export function buildProjectNotePaths(vaultRoot, projectName) {
  const projectRoot = path.join(vaultRoot, '01_Projects', projectName);
  return Object.fromEntries(CANONICAL_PROJECT_NOTE_TYPES.map((noteType) => [noteType, path.join(projectRoot, `${noteType}.md`)]));
}

export function buildGlobalNotePaths(vaultRoot) {
  return Object.fromEntries(Object.entries(CANONICAL_GLOBAL_NOTES).map(([key, relativePath]) => [key, path.join(vaultRoot, relativePath)]));
}

export function buildDeprecatedProjectPaths(vaultRoot, projectName) {
  const projectRoot = path.join(vaultRoot, '01_Projects', projectName);
  return {
    logs: path.join(projectRoot, 'logs.md'),
    knowledgeMirror: path.join(vaultRoot, '04_Knowledge_Base', `${projectName}.md`),
  };
}

export function isLegacyManagedText(text) {
  const value = String(text ?? '');
  return LEGACY_MARKERS.some((marker) => value.includes(marker)) || value.includes('## Generated Context');
}

export function stripLegacyManagedSections(text) {
  let value = String(text ?? '');
  for (const marker of LEGACY_MARKERS) {
    value = value.replaceAll(marker, '');
  }
  value = value.replace(/\n## Generated Context[\s\S]*$/m, '');
  return value.trimEnd();
}

export async function cleanupDeprecatedVaultArtifacts(vaultRoot, projectNames = []) {
  const removedPaths = [];
  for (const projectName of uniqueStrings(projectNames)) {
    const deprecatedPaths = buildDeprecatedProjectPaths(vaultRoot, projectName);
    for (const targetPath of Object.values(deprecatedPaths)) {
      try {
        await fs.rm(targetPath, { force: true });
        removedPaths.push(targetPath);
      } catch {
        continue;
      }
    }
  }

  for (const targetPath of await findRuntimeArtifactsInVault(vaultRoot)) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      removedPaths.push(targetPath);
    } catch {
      continue;
    }
  }

  return uniqueStrings(removedPaths);
}

export async function validateVaultContract(vaultRoot) {
  const issues = [];
  const projectRoot = path.join(vaultRoot, '01_Projects');
  const knowledgeBaseRoot = path.join(vaultRoot, '04_Knowledge_Base');
  const agentNotesRoot = path.join(vaultRoot, '03_Agent_Notes');
  const systemRoot = path.join(vaultRoot, '99_System');

  const projectNames = await listProjectNames(projectRoot);
  for (const projectName of projectNames) {
    const projectDirectory = path.join(projectRoot, projectName);
    const entries = await safeReadDirectory(projectDirectory);
    const markdownFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name).sort();
    const unexpectedFiles = markdownFiles.filter((fileName) => !CANONICAL_PROJECT_NOTE_FILES.includes(fileName));
    for (const fileName of unexpectedFiles) {
      issues.push({
        kind: 'unexpected-project-note',
        path: path.join(projectDirectory, fileName),
        message: `Unexpected project note ${fileName}. Canonical project folders should only contain ${CANONICAL_PROJECT_NOTE_FILES.join(', ')}.`,
      });
    }
    for (const fileName of markdownFiles.filter((file) => CANONICAL_PROJECT_NOTE_FILES.includes(file))) {
      const filePath = path.join(projectDirectory, fileName);
      const content = await safeReadText(filePath);
      if (isLegacyManagedText(content)) {
        issues.push({
          kind: 'legacy-marker',
          path: filePath,
          message: 'Canonical project notes must not contain generated marker boilerplate or generated-context sections.',
        });
      }
    }
  }

  const kbEntries = await safeReadDirectory(knowledgeBaseRoot);
  for (const entry of kbEntries.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))) {
    if (!CANONICAL_KNOWLEDGE_BASE_FILES.has(entry.name)) {
      issues.push({
        kind: 'unexpected-knowledge-note',
        path: path.join(knowledgeBaseRoot, entry.name),
        message: 'Project-specific knowledge-base mirror notes are deprecated. Keep cross-project reusable notes only.',
      });
    }
    const filePath = path.join(knowledgeBaseRoot, entry.name);
    const content = await safeReadText(filePath);
    if (isLegacyManagedText(content)) {
      issues.push({
        kind: 'legacy-marker',
        path: filePath,
        message: 'Knowledge-base notes must not contain generated marker boilerplate.',
      });
    }
  }

  await validateManagedArea(agentNotesRoot, CANONICAL_AGENT_NOTE_FILES, 'agent-notes', issues);
  await validateManagedArea(systemRoot, CANONICAL_SYSTEM_FILES, 'system-note', issues);

  for (const targetPath of await findRuntimeArtifactsInVault(vaultRoot)) {
    issues.push({
      kind: 'runtime-artifact',
      path: targetPath,
      message: 'Runtime artifacts do not belong in the vault.',
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    projectCount: projectNames.length,
  };
}

export function renderVaultValidationReport(report) {
  if (report.ok) {
    return [
      `Vault validation passed for ${report.projectCount} project folders.`,
      'No deprecated notes, marker boilerplate, or runtime artifacts were detected.',
    ].join('\n');
  }

  return [
    `Vault validation failed with ${report.issues.length} issue(s).`,
    ...report.issues.map((issue) => `- ${normalizeSlashes(issue.path)} | ${issue.message}`),
  ].join('\n');
}

export async function ensureVaultFolders(vaultRoot) {
  const folders = [
    '00_Inbox',
    '01_Projects',
    '02_Experiments',
    '03_Agent_Notes',
    '04_Knowledge_Base',
    '05_Daily_Logs',
    '06_Summaries',
    '99_System',
  ];
  await Promise.all(folders.map((folder) => ensureDir(path.join(vaultRoot, folder))));
}

async function listProjectNames(projectRoot) {
  const entries = await safeReadDirectory(projectRoot);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function validateManagedArea(rootPath, allowedBasenames, kind, issues) {
  const entries = await safeReadDirectory(rootPath);
  for (const entry of entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))) {
    if (!allowedBasenames.has(entry.name)) {
      issues.push({
        kind: `unexpected-${kind}`,
        path: path.join(rootPath, entry.name),
        message: `Unexpected ${kind} file ${entry.name}.`,
      });
    }
    const filePath = path.join(rootPath, entry.name);
    const content = await safeReadText(filePath);
    if (isLegacyManagedText(content)) {
      issues.push({
        kind: 'legacy-marker',
        path: filePath,
        message: `${entry.name} still contains generated marker boilerplate.`,
      });
    }
  }
}

async function findRuntimeArtifactsInVault(vaultRoot) {
  const matches = [];
  await walk(vaultRoot, async (entryPath, entry) => {
    const basename = path.basename(entryPath);
    const extension = path.extname(entryPath);
    if (entry.isFile() && (RUNTIME_ARTIFACT_BASENAMES.has(basename) || RUNTIME_ARTIFACT_EXTENSIONS.has(extension))) {
      matches.push(entryPath);
      return;
    }
    if (entry.isDirectory() && ['runtime', 'data', 'chroma', 'state'].includes(basename)) {
      matches.push(entryPath);
    }
  });
  return uniqueStrings(matches);
}

async function walk(rootPath, onEntry) {
  const entries = await safeReadDirectory(rootPath);
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    await onEntry(entryPath, entry);
    if (entry.isDirectory()) {
      await walk(entryPath, onEntry);
    }
  }
}

async function safeReadDirectory(directoryPath) {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeReadText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}