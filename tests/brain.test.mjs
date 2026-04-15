import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';

import { captureLearning, consultBrain, searchBrain } from '../packages/brain-service/index.mjs';
import { buildResearchConsultation, synthesizeLocalAndExternalGuidance } from '../packages/research/index.mjs';
import { BRAIN_MCP_TOOL_NAMES } from '../apps/mcp-server/index.mjs';
import { runDoctor, runEmbed, runQuery, runStatus, runSync } from '../apps/worker/index.mjs';
import { buildProjectKnowledgeSources, chunkProjectKnowledge, GLOBAL_KNOWLEDGE_CACHE_KEY } from '../packages/chunker/index.mjs';
import {
  inspectEmbedderRunner,
  resolveCliEmbedderSelection,
  startEmbedderRunner,
  stopEmbedderRunner,
} from '../packages/embedder-runner/index.mjs';
import { getEmbeddingServiceStatus, LocalSemanticEmbedder, prewarmEmbeddingService, shutdownEmbeddingService } from '../packages/embeddings/index.mjs';
import { normalizeProject } from '../packages/normalizer/index.mjs';
import { syncNotes, writeQueryHistoryNote } from '../packages/obsidian-writer/index.mjs';
import { expandQueryText, retrieveContext } from '../packages/retriever/index.mjs';
import { buildRuntimeConfig } from '../packages/shared/index.mjs';
import { getLastLearningActivityAt, loadState, normalizeState, recordMemoryUsage, summarizeMemoryAdmission } from '../packages/state-manager/index.mjs';
import { shutdownChromaService } from '../packages/vector-store/index.mjs';
import { cleanupDeprecatedVaultArtifacts, validateVaultContract } from '../packages/vault-contract/index.mjs';
import { analyzeProject } from '../scripts/ai-brain/lib/project-analysis.mjs';

const TEMP_PATHS = [];

after(async () => {
  await shutdownEmbeddingService();
  await shutdownChromaService();
  await Promise.all(TEMP_PATHS.map(async (tempPath) => {
    await rm(tempPath, { recursive: true, force: true });
  }));
});

test('chunker creates stable chunks for normalized project content', () => {
  const project = {
    name: 'demo',
    fingerprint: 'abc123',
    normalizedAt: '2026-04-11T00:00:00.000Z',
  };
  const sources = [
    {
      noteType: 'normalized-project',
      sourcePath: '/tmp/demo',
      tags: ['project'],
      text: 'Paragraph one about architecture.\n\nParagraph two about reusable patterns.\n\nParagraph three about risks.',
    },
  ];
  const chunks = chunkProjectKnowledge(project, sources, { maxChars: 60, overlapChars: 10 });
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].project, 'demo');
  assert.ok(chunks[0].metadata.chunkId);
});

test('semantic embedder produces equal vectors for equal text', async () => {
  const embedder = new LocalSemanticEmbedder({ dimensions: 64 });
  const left = await embedder.embedText('auth token refresh workflow');
  const right = await embedder.embedText('auth token refresh workflow');
  assert.deepEqual(left, right);
});

test('prewarmEmbeddingService readies and reuses the managed embedder without a duplicate process', async () => {
  await shutdownEmbeddingService();

  const first = await prewarmEmbeddingService({
    timeoutMs: 30000,
    reason: 'test-prewarm',
    strategy: 'blocking',
  });

  assert.equal(first.outcome, 'ready');
  assert.ok(first.servicePid);
  const statusAfterFirst = getEmbeddingServiceStatus();
  assert.equal(statusAfterFirst.serviceState, 'ready');
  assert.equal(statusAfterFirst.servicePid, first.servicePid);

  const second = await prewarmEmbeddingService({
    timeoutMs: 30000,
    reason: 'test-prewarm-reuse',
    strategy: 'blocking',
  });

  assert.equal(second.outcome, 'reused');
  assert.equal(second.servicePid, first.servicePid);
});

test('prewarmEmbeddingService timeout resets the managed embedder safely', async () => {
  await shutdownEmbeddingService();

  const timedOut = await prewarmEmbeddingService({
    timeoutMs: 1,
    reason: 'test-timeout',
    strategy: 'blocking',
  });

  assert.equal(timedOut.outcome, 'timed-out');
  assert.equal(getEmbeddingServiceStatus().serviceState, 'idle');
});

test('inspectEmbedderRunner reports not running before any runner is started', async () => {
  const fixture = await createRuntimeFixture('brain-runner-inspect-');
  const config = buildRuntimeConfig({
    ...fixture.runtimeOptions,
    embedderRunnerMode: 'auto',
  });

  const status = await inspectEmbedderRunner(config);

  assert.equal(status.running, false);
  assert.equal(status.stale, false);
  assert.equal(status.pid, null);
  assert.equal(status.backendIfQueriedNow, 'auto-start-runner');
});

test('startEmbedderRunner creates a healthy runtime and stopEmbedderRunner cleans it up without touching admission state', async () => {
  const fixture = await createRuntimeFixture('brain-runner-start-stop-');
  const config = buildRuntimeConfig({
    ...fixture.runtimeOptions,
    embedderRunnerMode: 'auto',
  });
  const before = await loadState(config);

  const started = await startEmbedderRunner(config, { reason: 'test start-stop' });
  try {
    assert.equal(started.status.running, true);
    assert.ok(started.status.pid);
    assert.equal(started.status.model, 'all-MiniLM-L6-v2');
    assert.equal(started.status.dimensions, 384);

    const running = await inspectEmbedderRunner(config);
    assert.equal(running.running, true);
    assert.equal(running.pid, started.status.pid);
    assert.equal(running.backendIfQueriedNow, 'runner');
  } finally {
    await stopEmbedderRunner(config, { reason: 'test cleanup' });
  }

  const stopped = await inspectEmbedderRunner(config);
  const after = await loadState(config);
  assert.equal(stopped.running, false);
  assert.equal(after.queryHistory.length, before.queryHistory.length);
  assert.equal(after.memoryAdmission.usageEvents.length, before.memoryAdmission.usageEvents.length);
});

test('startEmbedderRunner cleans stale pid and lock artifacts before starting', async () => {
  const fixture = await createRuntimeFixture('brain-runner-stale-');
  const config = buildRuntimeConfig({
    ...fixture.runtimeOptions,
    embedderRunnerMode: 'auto',
  });

  await mkdir(path.dirname(config.embedderRunnerPidPath), { recursive: true });
  await mkdir(path.dirname(config.embedderRunnerSocketPath), { recursive: true });
  await writeFile(config.embedderRunnerPidPath, '999999\n', 'utf8');
  await writeFile(config.embedderRunnerSocketPath, 'stale', 'utf8');
  await writeFile(config.embedderRunnerLockPath, '{}', 'utf8');
  const staleAt = new Date(Date.now() - 60_000);
  await utimes(config.embedderRunnerLockPath, staleAt, staleAt);

  const before = await inspectEmbedderRunner(config);
  assert.equal(before.stale, true);

  const started = await startEmbedderRunner(config, { reason: 'test stale cleanup' });
  try {
    assert.equal(started.status.running, true);
    assert.equal(started.status.stale, false);
    await assert.rejects(access(config.embedderRunnerLockPath));
  } finally {
    await stopEmbedderRunner(config, { reason: 'test cleanup' });
  }
});

test('startEmbedderRunner prevents duplicate starts under concurrent calls', async () => {
  const fixture = await createRuntimeFixture('brain-runner-duplicate-');
  const config = buildRuntimeConfig({
    ...fixture.runtimeOptions,
    embedderRunnerMode: 'auto',
  });

  const [first, second] = await Promise.all([
    startEmbedderRunner(config, { reason: 'test duplicate first' }),
    startEmbedderRunner(config, { reason: 'test duplicate second' }),
  ]);

  try {
    assert.equal(first.status.running, true);
    assert.equal(second.status.running, true);
    assert.equal(first.status.pid, second.status.pid);
    assert.ok(['started', 'already-running'].includes(first.action));
    assert.ok(['started', 'already-running'].includes(second.action));
  } finally {
    await stopEmbedderRunner(config, { reason: 'test cleanup' });
  }
});

test('resolveCliEmbedderSelection falls back in auto mode and fails clearly in require mode', async () => {
  const fallbackFixture = await createRuntimeFixture('brain-runner-auto-fallback-');
  const fallbackConfig = buildRuntimeConfig({
    ...fallbackFixture.runtimeOptions,
    embedderRunnerMode: 'auto',
  });

  const fallbackSelection = await resolveCliEmbedderSelection(fallbackConfig, {
    command: 'doctor',
    allowAutoStart: false,
  });
  assert.equal(fallbackSelection.backend, 'in-process');
  assert.match(fallbackSelection.fallbackReason, /not running/i);

  const requireFixture = await createRuntimeFixture('brain-runner-require-');
  const requireConfig = buildRuntimeConfig({
    ...requireFixture.runtimeOptions,
    embedderRunnerMode: 'require',
    embedderRunnerStartupTimeoutMs: 500,
    pythonExecutable: path.join(requireFixture.root, 'missing-python'),
  });

  await assert.rejects(
    resolveCliEmbedderSelection(requireConfig, { command: 'query', allowAutoStart: false }),
    /Persistent embedder runner is required but unavailable/,
  );
  await stopEmbedderRunner(requireConfig, { force: true, reason: 'test cleanup after require failure' });
});

test('query expansion adds related auth and retry terms for messy bug queries', () => {
  const expanded = expandQueryText('auth retry bug');
  assert.ok(expanded.expandedQueryText.includes('related concepts:'));
  assert.ok(expanded.expansionTerms.includes('authentication'));
  assert.ok(expanded.expansionTerms.includes('backoff'));
});

test('retrieveContext prefers strong current-project evidence over weaker cross-project similarity for repo-specific queries', async () => {
  const embedder = {
    async embedText() {
      return [0.25, 0.75];
    },
  };
  const currentProjectResult = {
    id: 'brain-learning',
    distance: 0.29,
    document: 'Place retry behavior at the shared client boundary instead of scattering retries across callers. Validate the change with the shared client tests.',
    metadata: {
      project: 'brain',
      noteType: 'learnings',
      sourcePath: '/tmp/brain/learnings.md',
      sourceKind: 'note',
      knowledgeType: 'proven-learning',
      knowledgeStrength: 'strong',
      evidenceQuality: 'strong',
      confidence: 0.92,
      supportCount: 2,
      supportingSources: JSON.stringify([
        {
          sourcePath: 'README.md',
          sourceKind: 'readme',
          sourceSection: 'Boundaries',
          excerpt: 'Place retry behavior at the shared client boundary.',
        },
      ]),
      derivedFrom: 'explicit-doc',
      evidenceSummary: 'Shared client boundary with strong evidence support.',
    },
  };
  const crossProjectResult = {
    id: 'other-learning',
    distance: 0.12,
    document: 'Retry behavior should be centralized somewhere in the request path for maintainability.',
    metadata: {
      project: 'other-repo',
      noteType: 'learnings',
      sourcePath: '/tmp/other/learnings.md',
      sourceKind: 'note',
      knowledgeType: 'proven-learning',
      knowledgeStrength: 'strong',
      evidenceQuality: 'weak',
      confidence: 0.34,
      supportCount: 0,
      supportingSources: '[]',
      derivedFrom: 'heuristic-fallback',
      evidenceSummary: 'Weak heuristic retry guidance.',
    },
  };
  const vectorStore = {
    async query(_embedding, options = {}) {
      if (options.where?.project === 'brain') {
        return { results: [currentProjectResult] };
      }
      return { results: [crossProjectResult, currentProjectResult] };
    },
  };

  const payload = await retrieveContext({
    queryText: 'safe place in this repo to change retry logic without breaking the shared client boundary',
    topK: 3,
    currentProjectName: 'brain',
    embedder,
    vectorStore,
  });

  assert.equal(payload.results[0].project, 'brain');
  assert.equal(payload.results[0].evidenceQuality, 'strong');
  assert.ok(payload.results[0].relevanceScore >= payload.results[1].relevanceScore);
});

test('retrieveContext uses deterministic tie-breakers when ranked results have equal scores', async () => {
  const embedder = {
    async embedText() {
      return [0.5, 0.5];
    },
  };
  const buildTiedResult = (project) => ({
    id: `${project}-learning`,
    distance: 0.3,
    document: 'Shared retry boundary guidance for outbound request handling.',
    metadata: {
      project,
      noteType: 'learnings',
      sourcePath: `/tmp/${project}/learnings.md`,
      sourceKind: 'note',
      knowledgeType: 'proven-learning',
      knowledgeStrength: 'strong',
      evidenceQuality: 'strong',
      confidence: 0.9,
      supportCount: 1,
      supportingSources: JSON.stringify([]),
      derivedFrom: 'explicit-doc',
      evidenceSummary: 'Tied ranking fixture.',
    },
  });
  const vectorStore = {
    async query() {
      return {
        results: [
          buildTiedResult('beta'),
          buildTiedResult('alpha'),
        ],
      };
    },
  };

  const payload = await retrieveContext({
    queryText: 'shared retry boundary',
    topK: 2,
    embedder,
    vectorStore,
  });

  assert.deepEqual(payload.results.map((result) => result.project), ['alpha', 'beta']);
});

test('project analysis extracts documentation-style patterns from strong repo surfaces', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'brain-doc-style-'));
  TEMP_PATHS.push(projectRoot);
  await mkdir(path.join(projectRoot, 'docs'), { recursive: true });
  await mkdir(path.join(projectRoot, '.github'), { recursive: true });

  await writeFile(path.join(projectRoot, 'README.md'), [
    '<div align="center">',
    '',
    '# Demo Docs Repo',
    '',
    '[![Local-First](https://img.shields.io/badge/Local--First-yes-0f766e?style=for-the-badge)](#getting-started)',
    '',
    '<a href="#product-surface">Product Surface</a> | <a href="#getting-started">Getting Started</a> | <a href="#appendix">Appendix</a>',
    '',
    '</div>',
    '',
    '## Product Surface',
    '',
    '<table><tr><td><img alt="panel" src="panel.svg"></td></tr></table>',
    '',
    '## Getting Started',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[README] --> B[Docs]',
    '```',
    '',
    '<details><summary>More</summary>',
    '',
    'Hidden appendix material.',
    '',
    '</details>',
    '',
    '## Appendix',
    '',
    'Reference material.',
  ].join('\n'), 'utf8');

  await writeFile(path.join(projectRoot, 'docs', 'ARCHITECTURE.md'), [
    '# Architecture',
    '',
    '## Overview',
    '',
    'Overview text.',
    '',
    '## Data Flow',
    '',
    'Flow text.',
  ].join('\n'), 'utf8');

  await writeFile(path.join(projectRoot, 'docs', 'TROUBLESHOOTING.md'), [
    '# Troubleshooting',
    '',
    '## Service Does Not Start',
    '',
    'Symptoms:',
    '- UI cannot connect.',
    '',
    'Checks:',
    '1. Start the service.',
  ].join('\n'), 'utf8');

  await writeFile(path.join(projectRoot, '.github', 'copilot-instructions.md'), '# Agent guidance\n', 'utf8');

  const analysis = await analyzeProject(projectRoot);

  assert.ok(analysis.documentationQualityScore >= 6);
  assert.ok(analysis.documentationPatterns.some((pattern) => pattern.includes('README opening sequence pattern')));
  assert.ok(analysis.documentationPatterns.some((pattern) => pattern.includes('Documentation layout pattern')));
  assert.ok(analysis.documentationPatterns.some((pattern) => pattern.includes('Agent guidance pattern')));
});

test('project analysis extracts boundary rules and validation surfaces from docs instead of fallback summaries', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'brain-signal-quality-'));
  TEMP_PATHS.push(projectRoot);

  await writeFile(path.join(projectRoot, 'README.md'), [
    '# Signal Quality Repo',
    '',
    '- Source repositories are read-only inputs.',
    '- Keep runtime state under data/ instead of the knowledge vault.',
    '',
    '```bash',
    'npm run doctor',
    'npm run validate:vault',
    '```',
  ].join('\n'), 'utf8');

  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'signal-quality-repo',
    private: true,
    scripts: {
      doctor: 'node doctor.mjs',
      test: 'node --test',
    },
  }, null, 2), 'utf8');

  const analysis = await analyzeProject(projectRoot);

  assert.ok(analysis.boundaryRules.some((rule) => /read-only inputs/i.test(rule)));
  assert.ok(analysis.validationSurfaces.some((surface) => /npm run doctor/i.test(surface)));
  assert.ok(analysis.problemsSolved.every((problem) => !/locally indexed software project tracked/i.test(problem)));
});

test('project analysis preserves provenance with source path, section, excerpt, and confidence', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'brain-provenance-'));
  TEMP_PATHS.push(projectRoot);

  await writeFile(path.join(projectRoot, 'README.md'), [
    '# Provenance Repo',
    '',
    '## Boundaries',
    '- Source repositories are read-only inputs.',
    '- Keep runtime state under data/ instead of the vault.',
    '',
    '## Validation',
    '```bash',
    'npm run doctor',
    '```',
  ].join('\n'), 'utf8');

  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'provenance-repo',
    private: true,
    scripts: {
      doctor: 'node doctor.mjs',
    },
  }, null, 2), 'utf8');

  const analysis = await analyzeProject(projectRoot);

  assert.equal(analysis.evidenceModelVersion, 'provenance-v1');
  const boundary = analysis.provenance.boundaryRules.find((item) => /read-only inputs/i.test(item.value));
  assert.ok(boundary);
  assert.equal(boundary.evidenceQuality, 'strong');
  assert.equal(boundary.sources[0].sourcePath, 'README.md');
  assert.equal(boundary.sources[0].sourceSection, 'Boundaries');
  assert.match(boundary.sources[0].excerpt, /read-only inputs/i);

  const validation = analysis.provenance.validationSurfaces.find((item) => /brain:doctor|doctor/i.test(item.value));
  assert.ok(validation);
  assert.ok(validation.confidence > 0.7);

  const documentedValidation = analysis.provenance.validationSurfaces.find((item) => /npm run doctor/i.test(item.value));
  assert.ok(documentedValidation);
  assert.equal(documentedValidation.sources[0].sourcePath, 'README.md');

  const scriptedValidation = analysis.provenance.validationSurfaces.find((item) => /Package script: doctor: node doctor\.mjs/i.test(item.value));
  assert.ok(scriptedValidation);
  assert.equal(scriptedValidation.sources[0].sourcePath, 'package.json');
});

test('normalizer preserves provenance and emits evidence traces into corpus text', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'brain-normalized-provenance-'));
  TEMP_PATHS.push(projectRoot);

  await mkdir(path.join(projectRoot, 'docs'), { recursive: true });
  await writeFile(path.join(projectRoot, 'README.md'), [
    '# Normalized Provenance Repo',
    '',
    '- Source repositories are read-only inputs.',
    '',
    '```bash',
    'npm run doctor',
    '```',
  ].join('\n'), 'utf8');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'normalized-provenance-repo',
    private: true,
    scripts: {
      doctor: 'node doctor.mjs',
    },
  }, null, 2), 'utf8');

  const analysis = await analyzeProject(projectRoot);
  const normalized = normalizeProject({ projectRoot, analysis, parsedAt: '2026-04-12T00:00:00.000Z' });

  assert.equal(normalized.evidenceModelVersion, 'provenance-v1');
  assert.ok(normalized.provenance.boundaryRules.length > 0);
  assert.equal(normalized.provenance.boundaryRules[0].sources[0].sourcePath, 'README.md');
  assert.match(normalized.corpusText, /Evidence traces:/);
});

test('chunker emits provenance-aware metadata for normalized project chunks', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'brain-chunk-provenance-'));
  TEMP_PATHS.push(projectRoot);

  await writeFile(path.join(projectRoot, 'README.md'), [
    '# Chunk Provenance Repo',
    '',
    '- Keep runtime state under data/ instead of the vault.',
    '',
    '```bash',
    'npm run doctor',
    '```',
  ].join('\n'), 'utf8');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'chunk-provenance-repo',
    private: true,
    scripts: {
      doctor: 'node doctor.mjs',
    },
  }, null, 2), 'utf8');

  const analysis = await analyzeProject(projectRoot);
  const normalized = normalizeProject({ projectRoot, analysis, parsedAt: '2026-04-12T00:00:00.000Z' });
  const sources = buildProjectKnowledgeSources(normalized, {});
  const chunks = chunkProjectKnowledge(normalized, sources, { maxChars: 220, overlapChars: 40 });

  assert.ok(chunks.length > 0);
  assert.equal(chunks[0].metadata.knowledgeType, 'project-snapshot');
  assert.ok(['weak', 'medium', 'strong'].includes(chunks[0].metadata.evidenceQuality));
  assert.ok(typeof chunks[0].metadata.confidence === 'number');
  assert.ok(typeof chunks[0].metadata.evidenceSummary === 'string');
  assert.ok(chunks[0].metadata.supportingSources.includes('sourcePath'));
});

test('searchBrain bootstraps a cold runtime and embeds global knowledge notes', async () => {
  const fixture = await createRuntimeFixture('brain-search-runtime-');
  await createSampleProject(path.join(fixture.projectsRoot, 'sample'));

  const payload = await searchBrain({
    query: 'read-only inputs',
    currentProjectName: 'sample',
    runtimeOptions: fixture.runtimeOptions,
  });

  assert.ok(Array.isArray(payload.results));
  assert.equal(payload.memoryAdmission.recorded, true);
  assert.ok(payload.memoryAdmission.queryFingerprint.length > 0);
  const config = buildRuntimeConfig(fixture.runtimeOptions);
  const state = await loadState(config);
  assert.ok(state.lastEmbedAt);

  const knowledgeChunkPath = path.join(config.chunkCacheRoot, `${GLOBAL_KNOWLEDGE_CACHE_KEY}.json`);
  const knowledgeChunks = JSON.parse(await readFile(knowledgeChunkPath, 'utf8'));
  assert.ok(knowledgeChunks.some((chunk) => /reusable-patterns\.md$/i.test(chunk.sourcePath)));
  assert.ok(knowledgeChunks.some((chunk) => /documentation-style-patterns\.md$/i.test(chunk.sourcePath)));

  const queryHistoryPath = path.join(fixture.vaultRoot, '03_Agent_Notes', 'query-history.md');
  const queryHistory = await readFile(queryHistoryPath, 'utf8');
  assert.ok(queryHistory.includes('## Useful Query Patterns'));
  assert.ok(!queryHistory.includes('read-only inputs'));
  assert.ok(!queryHistory.includes('## Recent Queries'));
});

test('searchBrain and consultBrain still work after embedder prewarm', async () => {
  const fixture = await createRuntimeFixture('brain-prewarm-runtime-');
  await createSampleProject(path.join(fixture.projectsRoot, 'sample'));
  const config = buildRuntimeConfig(fixture.runtimeOptions);

  const prewarm = await prewarmEmbeddingService({
    pythonExecutable: config.pythonExecutable,
    timeoutMs: 30000,
    reason: 'test-runtime-prewarm',
    strategy: 'blocking',
  });

  assert.ok(['ready', 'reused'].includes(prewarm.outcome));

  const searchPayload = await searchBrain({
    query: 'read-only inputs',
    currentProjectName: 'sample',
    runtimeOptions: fixture.runtimeOptions,
  });
  assert.ok(searchPayload.results.length > 0);

  const consultation = await consultBrain({
    query: 'best practice for token refresh handling',
    currentProjectName: 'sample',
    runtimeOptions: fixture.runtimeOptions,
    recordUsage: false,
  });
  assert.ok(['local-only', 'local-plus-web-assist', 'web-first-local-adaptation'].includes(consultation.mode));
  assert.ok(consultation.decisionTrace);
});

test('searchBrain and consultBrain can reuse the persistent embedder runner without changing behavior', async () => {
  const fixture = await createRuntimeFixture('brain-runner-runtime-');
  await createSampleProject(path.join(fixture.projectsRoot, 'sample'));
  const runtimeOptions = {
    ...fixture.runtimeOptions,
    embedderRunnerMode: 'auto',
  };
  const config = buildRuntimeConfig(runtimeOptions);
  await startEmbedderRunner(config, { reason: 'test runtime runner reuse' });

  try {
    const selection = await resolveCliEmbedderSelection(config, {
      command: 'query',
      allowAutoStart: true,
    });
    const searchPayload = await searchBrain({
      query: 'read-only inputs',
      currentProjectName: 'sample',
      runtimeOptions,
      includeEmbedderRuntime: true,
      embedderSelection: selection,
    });
    assert.ok(searchPayload.results.length > 0);
    assert.equal(searchPayload.embedderRuntime.backend, 'runner');

    const consultation = await consultBrain({
      query: 'best practice for token refresh handling',
      currentProjectName: 'sample',
      runtimeOptions,
      recordUsage: false,
      includeEmbedderRuntime: true,
      embedderSelection: selection,
    });
    assert.ok(['local-only', 'local-plus-web-assist', 'web-first-local-adaptation'].includes(consultation.mode));
    assert.equal(consultation.embedderRuntime.backend, 'runner');
  } finally {
    await stopEmbedderRunner(config, { reason: 'test cleanup' });
  }
});

test('captureLearning appends a structured learning through the supported brain-service path', async () => {
  const fixture = await createRuntimeFixture('brain-capture-runtime-');
  await createSampleProject(path.join(fixture.projectsRoot, 'sample'));

  const payload = await captureLearning({
    title: 'Capture learning regression test',
    projectName: 'sample',
    problem: 'Verify captureLearning after runtime export changes.',
    context: 'Strict audit regression coverage.',
    solution: 'Call the supported brain-service captureLearning path with fixture runtime options.',
    whyItWorked: 'The brain-service and state-manager exports stay in sync for direct capture invocation.',
    reusablePattern: 'Add a regression test when long-lived runtime exports change.',
    tags: ['test', 'capture-learning'],
    runtimeOptions: fixture.runtimeOptions,
  });

  assert.equal(payload.projectName, 'sample');
  assert.equal(payload.embedded, true);
  const config = buildRuntimeConfig(fixture.runtimeOptions);
  const state = await loadState(config);
  assert.equal(state.lastLearnAt, payload.capturedAt);
  const noteText = await readFile(path.join(fixture.vaultRoot, '01_Projects', 'sample', 'learnings.md'), 'utf8');
  assert.match(noteText, /Capture learning regression test/);
  assert.match(noteText, /Strict audit regression coverage/);
});

test('syncNotes keeps global summaries based on the full knowledge project set during scoped sync', async () => {
  const fixture = await createRuntimeFixture('brain-sync-scope-');
  const config = buildRuntimeConfig(fixture.runtimeOptions);
  const state = normalizeState(config, {});
  const alpha = createProjectStub('alpha');
  const beta = createProjectStub('beta');

  await syncNotes(config, state, [alpha], {
    changedProjects: ['alpha'],
    knowledgeProjects: [alpha, beta],
  });

  const projectIndex = await readFile(path.join(config.vaultRoot, '01_Projects', '_Project_Index.md'), 'utf8');
  assert.ok(projectIndex.includes('alpha'));
  assert.ok(projectIndex.includes('beta'));
});

test('research consultation escalates token refresh best-practice queries to web-first mode', () => {
  const consultation = buildResearchConsultation({
    query: 'best practice for token refresh handling',
    currentProjectName: 'brain',
    currentProjectPath: '/tmp/brain',
    retrievalResponse: {
      results: [
        {
          project: 'brain',
          noteType: 'prompts',
          sourcePath: '/tmp/brain/prompts.md',
          relevanceScore: 0.34,
          whyMatched: 'weak semantic match',
          snippet: 'Prompt patterns and retrieval anchors.',
          matchedTerms: ['token'],
        },
      ],
    },
    reasoning: {
      relatedProjects: ['brain'],
      improvementRecommendations: ['Promote repeated auth fixes only after validation.'],
    },
    projectSummary: {
      relevantLearnings: {
        solution: ['Store architecture and operating knowledge next to implementation.'],
        reusablePattern: ['Encode repeated workflows as local scripts so agents can replay them deterministically.'],
        whyItWorked: ['Automation-first workflow with scriptable entrypoints'],
      },
      projectPatterns: ['Encode repeated workflows as local scripts so agents can replay them deterministically.'],
      noteReferences: {
        overview: '/tmp/brain/overview.md',
        architecture: '/tmp/brain/architecture.md',
        learnings: '/tmp/brain/learnings.md',
        prompts: '/tmp/brain/prompts.md',
        knowledge: '/tmp/brain/reusable-patterns.md',
      },
      stack: ['JavaScript', 'Node.js'],
    },
    relatedPatterns: [],
    recentLearnings: [],
  });

  assert.equal(consultation.mode, 'web-first-local-adaptation');
  assert.equal(consultation.researchDecision.needsWebResearch, true);
  assert.ok(consultation.researchPlan.sourceTargets.some((target) => target.tier === 'tier-1-official'));
  assert.ok(consultation.decisionTrace.score >= consultation.decisionTrace.thresholds.webFirstLocalAdaptation);
  assert.ok(consultation.decisionTrace.primaryDrivers.some((item) => /current guidance|security/i.test(item)));
});

test('research consultation stays local-only for repo-shaped questions with strong local evidence', () => {
  const consultation = buildResearchConsultation({
    query: 'how should this project organize reusable notes and prompts',
    currentProjectName: 'brain',
    currentProjectPath: '/tmp/brain',
    retrievalResponse: {
      results: [
        {
          project: 'brain',
          noteType: 'learnings',
          sourcePath: '/tmp/brain/learnings.md',
          relevanceScore: 0.86,
          whyMatched: 'strong same-project evidence',
          snippet: 'Store architecture and operating knowledge next to implementation.',
          matchedTerms: ['project', 'reusable', 'notes', 'prompts'],
        },
        {
          project: 'brain',
          noteType: 'knowledge',
          sourcePath: '/tmp/brain/reusable-patterns.md',
          relevanceScore: 0.73,
          whyMatched: 'strong reusable pattern evidence',
          snippet: 'Capture repeatable implementation decisions in dedicated notes so future agents can reuse them quickly.',
          matchedTerms: ['reusable', 'notes'],
        },
      ],
    },
    reasoning: {
      relatedProjects: ['brain'],
      improvementRecommendations: [],
    },
    projectSummary: {
      relevantLearnings: {
        solution: ['Store architecture and operating knowledge next to implementation.'],
        reusablePattern: ['Capture repeatable implementation decisions in dedicated notes so future agents can reuse them quickly.'],
        whyItWorked: ['Architecture and operating context stay close to the code.'],
      },
      projectPatterns: ['Store architecture and operating knowledge next to implementation to keep drift visible.'],
      noteReferences: {
        overview: '/tmp/brain/overview.md',
        architecture: '/tmp/brain/architecture.md',
        learnings: '/tmp/brain/learnings.md',
        prompts: '/tmp/brain/prompts.md',
        knowledge: '/tmp/brain/reusable-patterns.md',
      },
      stack: ['JavaScript', 'Node.js'],
    },
    relatedPatterns: [],
    recentLearnings: [],
  });

  assert.equal(consultation.mode, 'local-only');
  assert.equal(consultation.researchDecision.needsWebResearch, false);
});

test('research consultation stays local-only for medium-confidence repo-specific retry boundary questions', () => {
  const consultation = buildResearchConsultation({
    query: 'safe place in this repo to change retry logic without breaking the shared client boundary',
    currentProjectName: 'brain',
    currentProjectPath: '/tmp/brain',
    retrievalResponse: {
      results: [
        {
          project: 'brain',
          noteType: 'learnings',
          sourcePath: '/tmp/brain/learnings.md',
          relevanceScore: 0.61,
          whyMatched: 'same project reusable retry boundary',
          snippet: 'Place retry behavior at the shared client boundary instead of scattering retries across callers.',
          matchedTerms: ['retry', 'shared', 'client', 'boundary'],
        },
        {
          project: 'brain',
          noteType: 'prompts',
          sourcePath: '/tmp/brain/prompts.md',
          relevanceScore: 0.55,
          whyMatched: 'same project safe-change prompt',
          snippet: 'Name the command or validation surface that proves the change is safe.',
          matchedTerms: ['safe', 'change', 'boundary'],
        },
      ],
    },
    reasoning: {
      relatedProjects: ['brain'],
      improvementRecommendations: [],
    },
    projectSummary: {
      relevantLearnings: {
        solution: ['Place retry behavior at the shared client boundary instead of scattering retries across callers.'],
        reusablePattern: ['Central retry wrapper for outbound API clients'],
        whyItWorked: ['Shared wrappers keep retry behavior consistent.'],
      },
      projectPatterns: ['Central retry wrapper for outbound API clients'],
      documentationPatterns: [],
      noteReferences: {
        overview: '/tmp/brain/overview.md',
        architecture: '/tmp/brain/architecture.md',
        learnings: '/tmp/brain/learnings.md',
        prompts: '/tmp/brain/prompts.md',
        knowledge: '/tmp/brain/reusable-patterns.md',
        documentationStyle: '/tmp/brain/documentation-style-patterns.md',
      },
      stack: ['JavaScript', 'Node.js'],
    },
    relatedPatterns: [],
    recentLearnings: [],
  });

  assert.equal(consultation.mode, 'local-only');
  assert.equal(consultation.researchDecision.needsWebResearch, false);
  assert.ok(consultation.decisionTrace.score < consultation.decisionTrace.thresholds.localPlusWebAssist);
  assert.ok(consultation.decisionTrace.stabilizers.some((item) => /repo-specific anchor/i.test(item)));
});

test('repo-specific consultation lowers confidence when cross-project evidence outranks current-project evidence', () => {
  const consultation = buildResearchConsultation({
    query: 'safe place in this repo to change retry logic without breaking the shared client boundary',
    currentProjectName: 'brain',
    currentProjectPath: '/tmp/brain',
    retrievalResponse: {
      results: [
        {
          project: 'other-repo',
          noteType: 'learnings',
          sourcePath: '/tmp/other-repo/learnings.md',
          sourceKind: 'note',
          relevanceScore: 0.91,
          whyMatched: 'cross-project retry pattern',
          whyTrusted: 'source is a structured learning note; evidence quality: strong; confidence: 0.90',
          snippet: 'Place retry behavior in a shared outbound client wrapper.',
          matchedTerms: ['retry', 'shared', 'boundary'],
          evidenceQuality: 'strong',
          confidence: 0.9,
          supportCount: 2,
          supportingSources: [
            {
              sourcePath: 'other/README.md',
              sourceKind: 'readme',
              sourceSection: 'Boundaries',
              excerpt: 'Place retry behavior in a shared outbound client wrapper.',
            },
          ],
        },
        {
          project: 'brain',
          noteType: 'learnings',
          sourcePath: '/tmp/brain/learnings.md',
          sourceKind: 'note',
          relevanceScore: 0.73,
          whyMatched: 'current project retry boundary',
          whyTrusted: 'source is a structured learning note; evidence quality: strong; confidence: 0.82',
          snippet: 'Place retry behavior at the shared client boundary instead of scattering retries across callers.',
          matchedTerms: ['retry', 'shared', 'client', 'boundary'],
          evidenceQuality: 'strong',
          confidence: 0.82,
          supportCount: 1,
          supportingSources: [
            {
              sourcePath: 'brain/README.md',
              sourceKind: 'readme',
              sourceSection: 'Boundaries',
              excerpt: 'Place retry behavior at the shared client boundary instead of scattering retries across callers.',
            },
          ],
        },
      ],
    },
    reasoning: {
      relatedProjects: ['other-repo', 'brain'],
      improvementRecommendations: [],
    },
    projectSummary: {
      relevantLearnings: {
        solution: ['Place retry behavior at the shared client boundary instead of scattering retries across callers.'],
        reusablePattern: ['Central retry wrapper for outbound API clients'],
        whyItWorked: ['Shared wrappers keep retry behavior consistent.'],
      },
      projectPatterns: ['Central retry wrapper for outbound API clients'],
      documentationPatterns: [],
      provenance: {
        purpose: null,
        boundaries: [],
        validationSurfaces: [],
        reusableSolutions: [],
        documentationPatterns: [],
      },
      noteReferences: {
        overview: '/tmp/brain/overview.md',
        architecture: '/tmp/brain/architecture.md',
        learnings: '/tmp/brain/learnings.md',
        prompts: '/tmp/brain/prompts.md',
        knowledge: '/tmp/brain/reusable-patterns.md',
        documentationStyle: '/tmp/brain/documentation-style-patterns.md',
      },
      stack: ['JavaScript', 'Node.js'],
    },
    relatedPatterns: [],
    recentLearnings: [],
  });

  assert.equal(consultation.localConfidence.level, 'medium');
  assert.ok(consultation.trustSummary.strongestBasis.some((item) => item.includes('Current-project evidence')));
  assert.ok(consultation.trustSummary.weakerAreas.some((item) => /cross-project/i.test(item)));
});

test('research consultation reuses documentation-style patterns for repo-facing doc tasks', () => {
  const consultation = buildResearchConsultation({
    query: 'how should this repo README and AGENTS docs look',
    currentProjectName: 'brain',
    currentProjectPath: '/tmp/brain',
    retrievalResponse: {
      results: [
        {
          project: 'brain',
          noteType: 'normalized-project',
          sourcePath: '/tmp/brain',
          relevanceScore: 0.83,
          whyMatched: 'strong same-project docs evidence',
          snippet: 'README opening sequence pattern and documentation layout pattern.',
          matchedTerms: ['readme', 'docs'],
        },
      ],
    },
    reasoning: {
      relatedProjects: ['brain'],
      improvementRecommendations: [],
    },
    projectSummary: {
      relevantLearnings: {
        solution: ['Keep repo-facing docs layered instead of flattening them into one README.'],
        reusablePattern: ['README opening sequence pattern: centered hero, concise framing, badges, and anchor navigation before deeper detail.'],
        whyItWorked: ['The repo becomes easier to scan without sacrificing engineering detail.'],
      },
      projectPatterns: ['Store architecture and operating knowledge next to implementation to keep drift visible.'],
      documentationPatterns: ['README opening sequence pattern: centered hero, concise framing, badges, and anchor navigation before deeper detail.'],
      noteReferences: {
        overview: '/tmp/brain/overview.md',
        architecture: '/tmp/brain/architecture.md',
        learnings: '/tmp/brain/learnings.md',
        prompts: '/tmp/brain/prompts.md',
        knowledge: '/tmp/brain/reusable-patterns.md',
        documentationStyle: '/tmp/brain/documentation-style-patterns.md',
      },
      stack: ['JavaScript', 'Node.js'],
    },
    relatedPatterns: [],
    recentLearnings: [],
  });

  assert.ok(consultation.localContext.projectPatterns.some((pattern) => pattern.includes('README opening sequence pattern')));
});

test('research consultation exposes trust summary and local evidence basis', () => {
  const consultation = buildResearchConsultation({
    query: 'safe place in this repo to change retry logic without breaking the shared client boundary',
    currentProjectName: 'brain',
    currentProjectPath: '/tmp/brain',
    retrievalResponse: {
      results: [
        {
          project: 'brain',
          noteType: 'learnings',
          sourcePath: '/tmp/brain/learnings.md',
          sourceKind: 'note',
          relevanceScore: 0.78,
          whyMatched: 'same project boundary match',
          whyTrusted: 'source is a structured learning note; evidence quality: strong; confidence: 0.88',
          snippet: 'Place retry behavior at the shared client boundary instead of scattering retries across callers.',
          matchedTerms: ['retry', 'boundary'],
          evidenceQuality: 'strong',
          confidence: 0.88,
          supportCount: 2,
          supportingSources: [
            {
              sourcePath: 'README.md',
              sourceKind: 'readme',
              sourceSection: 'Boundaries',
              excerpt: 'Place retry behavior at the shared client boundary.',
            },
          ],
        },
      ],
    },
    reasoning: {
      relatedProjects: ['brain'],
      improvementRecommendations: [],
    },
    projectSummary: {
      relevantLearnings: {
        problem: 'Retry logic can fragment across callers.',
        solution: ['Place retry behavior at the shared client boundary instead of scattering retries across callers.'],
        whyItWorked: ['Shared wrappers keep retry behavior consistent.'],
        reusablePattern: ['Central retry wrapper for outbound API clients'],
        followUp: [],
        evidenceQuality: 'strong',
        confidence: 0.88,
        supportingSources: [
          {
            sourcePath: 'README.md',
            sourceKind: 'readme',
            sourceSection: 'Boundaries',
            excerpt: 'Place retry behavior at the shared client boundary.',
          },
        ],
      },
      projectPatterns: ['Central retry wrapper for outbound API clients'],
      documentationPatterns: [],
      provenance: {
        purpose: null,
        boundaries: [
          {
            id: '1',
            category: 'boundaryRules',
            value: 'Place retry behavior at the shared client boundary instead of scattering retries across callers.',
            confidence: 0.88,
            evidenceQuality: 'strong',
            derivedFrom: 'explicit-doc',
            supportCount: 1,
            sources: [
              {
                sourcePath: 'README.md',
                sourceKind: 'readme',
                sourceSection: 'Boundaries',
                excerpt: 'Place retry behavior at the shared client boundary.',
              },
            ],
          },
        ],
        validationSurfaces: [],
        reusableSolutions: [],
        documentationPatterns: [],
      },
      noteReferences: {
        overview: '/tmp/brain/overview.md',
        architecture: '/tmp/brain/architecture.md',
        learnings: '/tmp/brain/learnings.md',
        prompts: '/tmp/brain/prompts.md',
        knowledge: '/tmp/brain/reusable-patterns.md',
        documentationStyle: '/tmp/brain/documentation-style-patterns.md',
      },
      stack: ['JavaScript', 'Node.js'],
    },
    relatedPatterns: [
      {
        patternTitle: 'Central retry wrapper for outbound API clients',
        explanation: 'Reuse when the project needs retry policy at a shared transport boundary.',
        sourceProjects: ['brain'],
        supportingEvidence: [
          {
            sourcePath: 'README.md',
            sourceKind: 'readme',
            sourceSection: 'Boundaries',
            excerpt: 'Place retry behavior at the shared client boundary.',
          },
        ],
        evidenceQuality: 'strong',
        confidence: 0.84,
        supportCount: 1,
        whyTrusted: 'evidence quality: strong; confidence: 0.84',
        relevanceScore: 0.84,
      },
    ],
    recentLearnings: [],
  });

  assert.equal(consultation.trustSummary.localEvidenceQuality, 'strong');
  assert.ok(consultation.trustSummary.strongestBasis.some((item) => item.includes('README.md')));
  assert.ok(consultation.localContext.evidenceBasis.some((item) => item.includes('README.md')));
  assert.equal(consultation.evidence.topResults[0].supportingSources[0].sourcePath, 'README.md');
});

test('guidance synthesis promotes retry guidance to a reusable pattern only when local and external evidence align', () => {
  const consultation = buildResearchConsultation({
    query: 'current recommended pattern for request retries',
    currentProjectName: 'brain',
    currentProjectPath: '/tmp/brain',
    retrievalResponse: {
      results: [
        {
          project: 'brain',
          noteType: 'learnings',
          sourcePath: '/tmp/brain/learnings.md',
          relevanceScore: 0.82,
          whyMatched: 'same project and reusable pattern coverage',
          snippet: 'Place retry behavior at the shared client boundary instead of scattering retries across callers.',
          matchedTerms: ['retry', 'request'],
        },
      ],
    },
    reasoning: {
      relatedProjects: ['brain'],
      improvementRecommendations: [],
    },
    projectSummary: {
      relevantLearnings: {
        solution: ['Place retry behavior at the shared client boundary instead of scattering retries across callers.'],
        reusablePattern: ['Central retry wrapper for outbound API clients'],
        whyItWorked: ['Shared wrappers keep retry behavior consistent.'],
      },
      projectPatterns: ['Central retry wrapper for outbound API clients'],
      noteReferences: {
        overview: '/tmp/brain/overview.md',
        architecture: '/tmp/brain/architecture.md',
        learnings: '/tmp/brain/learnings.md',
        prompts: '/tmp/brain/prompts.md',
        knowledge: '/tmp/brain/reusable-patterns.md',
      },
      stack: ['JavaScript', 'Node.js'],
    },
    relatedPatterns: [
      {
        patternTitle: 'Central retry wrapper for outbound API clients',
        explanation: 'Reuse when the project needs retry policy at a shared transport boundary.',
        sourceProjects: ['brain'],
        relevanceScore: 0.84,
      },
    ],
    recentLearnings: [],
  });

  const synthesis = synthesizeLocalAndExternalGuidance({
    consultation,
    externalFindings: [
      {
        source_label: 'Example official docs',
        source_tier: 'tier-1-official',
        guidance: 'Use exponential backoff with jitter and place retry behavior in a shared client or transport layer. Retry only idempotent operations.',
      },
    ],
    noteTargets: {
      candidate: '/tmp/research-candidates.md',
      projectLearnings: '/tmp/brain/learnings.md',
      reusablePatterns: '/tmp/reusable-patterns.md',
    },
  });

  assert.equal(synthesis.memoryDecision.shouldPromoteReusablePattern, true);
  assert.equal(synthesis.memoryDecision.suggestedPattern, 'Central retry wrapper for outbound API clients');
});

test('query history rewrite preserves curated sections while removing generated markers', async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), 'brain-vault-'));
  TEMP_PATHS.push(vaultRoot);
  const queryHistoryPath = path.join(vaultRoot, '03_Agent_Notes', 'query-history.md');
  await mkdir(path.dirname(queryHistoryPath), { recursive: true });
  await writeFile(queryHistoryPath, [
    '# Query History',
    '',
    'Keep this note short and curated. Raw query and consultation telemetry lives in `data/state/brain-state.json`, not in the vault.',
    '',
    '## Query shapes that work well',
    '- Similar bug fix plus symptom plus subsystem plus repo.',
    '',
    '## Strong retrieval topics',
    '- BAHT deploy safety and monetization boundaries.',
    '',
    '## Weak retrieval topics',
    '- Artifact archives with little source-level decision context.',
    '',
    '## Query hygiene',
    '- Name the project whenever possible.',
    '',
    '## Reusable query patterns',
    '- Promote repeated wording into prompts rather than storing transcripts here.',
    '',
    '## Promotion rule',
    'If the same query wording leads to a good result twice, promote it.',
    '',
    '## Generated Context',
    '<!-- BRAIN:GENERATED_START -->',
    'Updated: 2026-04-12T00:00:00.000Z',
    '',
    '## Recent Queries',
    '- stale query',
    '<!-- BRAIN:GENERATED_END -->',
    '',
  ].join('\n'), 'utf8');

  await writeQueryHistoryNote({ vaultRoot }, [
    {
      at: '2026-04-12T18:00:00.000Z',
      query: 'safe place to change retry logic in brain',
      relatedProjects: ['brain'],
      mode: 'local-only',
    },
  ]);

  const updated = await readFile(queryHistoryPath, 'utf8');
  assert.ok(updated.startsWith('---\n'));
  assert.ok(updated.includes('## Useful Query Patterns'));
  assert.ok(updated.includes('## What Belongs Here'));
  assert.ok(updated.includes('## What Stays In Runtime State'));
  assert.ok(updated.includes('## Promotion Criteria'));
  assert.ok(updated.includes('## Last Curated'));
  assert.ok(!updated.includes('safe place to change retry logic in brain'));
  assert.ok(!updated.includes('## Projects Recalled Most Often'));
  assert.ok(!updated.includes('## Recent Queries'));
  assert.ok(!updated.includes('## Strong retrieval topics'));
  assert.ok(!updated.includes('## Weak retrieval topics'));
  assert.ok(!updated.includes('## Generated Context'));
  assert.ok(!updated.includes('<!-- BRAIN:GENERATED_START -->'));
});

test('runQuery records runtime query state without rewriting curated query-history note', async () => {
  const fixture = await createRuntimeFixture('brain-query-runtime-');
  await createSampleProject(path.join(fixture.projectsRoot, 'sample'));

  await runSync(fixture.runtimeOptions);
  await runEmbed(fixture.runtimeOptions);

  const queryHistoryPath = path.join(fixture.vaultRoot, '03_Agent_Notes', 'query-history.md');
  const before = await readFile(queryHistoryPath, 'utf8');
  assert.ok(before.includes('## Useful Query Patterns'));

  await runQuery({
    ...fixture.runtimeOptions,
    queryText: 'safe place in this repo to change retry logic without breaking the shared client boundary',
    currentProjectName: 'sample',
  });

  const after = await readFile(queryHistoryPath, 'utf8');
  assert.equal(after, before);
  assert.ok(!after.includes('## Recent Queries'));
  assert.ok(!after.includes('safe place in this repo to change retry logic without breaking the shared client boundary'));

  const config = buildRuntimeConfig(fixture.runtimeOptions);
  const state = await loadState(config);
  assert.ok(state.queryHistory.some((entry) => entry.query === 'safe place in this repo to change retry logic without breaking the shared client boundary'));
});

test('runDoctor does not add query history entries during smoke checks', async () => {
  const fixture = await createRuntimeFixture('brain-doctor-runtime-');
  await createSampleProject(path.join(fixture.projectsRoot, 'sample'));

  await searchBrain({
    query: 'read-only inputs',
    currentProjectName: 'sample',
    runtimeOptions: fixture.runtimeOptions,
  });

  const config = buildRuntimeConfig(fixture.runtimeOptions);
  const before = await loadState(config);
  const doctorReport = await runDoctor(fixture.runtimeOptions);
  const afterState = await loadState(config);

  assert.equal(afterState.queryHistory.length, before.queryHistory.length);
  assert.deepEqual(afterState.queryHistory.map((entry) => entry.query), before.queryHistory.map((entry) => entry.query));
  assert.equal(afterState.memoryAdmission.usageEvents.length, before.memoryAdmission.usageEvents.length);
  assert.ok(doctorReport.embedderPrewarm);
  assert.ok(['ready', 'reused', 'timed-out', 'failed', 'skipped'].includes(doctorReport.embedderPrewarm.outcome));
  assert.ok(doctorReport.retrievalDiagnostics);
  assert.ok(doctorReport.retrievalDiagnostics.projects.length >= 1);
  assert.ok(typeof doctorReport.queryCheck.latencyMs === 'number');
  assert.ok(typeof doctorReport.consultCheck.decisionScore === 'number');
  assert.ok(doctorReport.memoryAdmission);
});

test('runStatus and runDoctor expose runner diagnostics when the runner is already active', async () => {
  const fixture = await createRuntimeFixture('brain-doctor-runner-runtime-');
  await createSampleProject(path.join(fixture.projectsRoot, 'sample'));
  const runtimeOptions = {
    ...fixture.runtimeOptions,
    embedderRunnerMode: 'auto',
  };
  const config = buildRuntimeConfig(runtimeOptions);
  await searchBrain({
    query: 'read-only inputs',
    currentProjectName: 'sample',
    runtimeOptions: fixture.runtimeOptions,
  });
  await startEmbedderRunner(config, { reason: 'test doctor status runner diagnostics' });
  const before = await loadState(config);

  try {
    const statusReport = await runStatus(runtimeOptions);
    assert.equal(statusReport.embedderRunner.running, true);
    assert.equal(statusReport.embedderRunner.backendIfQueriedNow, 'runner');

    const doctorReport = await runDoctor(runtimeOptions);
    const afterState = await loadState(config);

    assert.equal(doctorReport.embedderRunner.running, true);
    assert.equal(doctorReport.embedderRunner.selectedBackend, 'runner');
    assert.equal(doctorReport.queryCheck.embedderRuntime.backend, 'runner');
    assert.equal(doctorReport.consultCheck.embedderRuntime.backend, 'runner');
    assert.equal(doctorReport.embedderPrewarm.outcome, 'skipped');
    assert.equal(afterState.queryHistory.length, before.queryHistory.length);
    assert.equal(afterState.memoryAdmission.usageEvents.length, before.memoryAdmission.usageEvents.length);
  } finally {
    await stopEmbedderRunner(config, { reason: 'test cleanup' });
  }
});

test('vault validation flags deprecated project mirrors, junk artifacts, and broken links', async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), 'brain-vault-'));
  TEMP_PATHS.push(vaultRoot);
  await mkdir(path.join(vaultRoot, '01_Projects', 'demo'), { recursive: true });
  await mkdir(path.join(vaultRoot, '03_Agent_Notes'), { recursive: true });
  await mkdir(path.join(vaultRoot, '04_Knowledge_Base'), { recursive: true });
  await mkdir(path.join(vaultRoot, '99_System'), { recursive: true });

  await writeFile(path.join(vaultRoot, '01_Projects', 'demo', 'overview.md'), [
    '# demo Overview',
    '',
    '## Generated Context',
    '<!-- AI_BRAIN:GENERATED_START -->',
    'stale generated content',
    '<!-- AI_BRAIN:GENERATED_END -->',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(vaultRoot, '01_Projects', 'demo', 'learnings.md'), '# demo Learnings\n\nProject: [[missing-demo-target]]\n', 'utf8');
  await writeFile(path.join(vaultRoot, '01_Projects', 'demo', 'architecture.md'), '# demo Architecture\n', 'utf8');
  await writeFile(path.join(vaultRoot, '01_Projects', 'demo', 'prompts.md'), '# demo Prompts\n', 'utf8');
  await writeFile(path.join(vaultRoot, '01_Projects', 'demo', 'logs.md'), '# demo Logs\n', 'utf8');
  await writeFile(path.join(vaultRoot, '04_Knowledge_Base', 'documentation-style-patterns.md'), '# Documentation Style Patterns\n', 'utf8');
  await writeFile(path.join(vaultRoot, '04_Knowledge_Base', 'demo.md'), '# demo Knowledge\n', 'utf8');
  await writeFile(path.join(vaultRoot, '.DS_Store'), 'junk', 'utf8');

  const report = await validateVaultContract(vaultRoot);

  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.kind === 'legacy-marker' && issue.path.endsWith(path.join('01_Projects', 'demo', 'overview.md'))));
  assert.ok(report.issues.some((issue) => issue.kind === 'unexpected-project-note' && issue.path.endsWith(path.join('01_Projects', 'demo', 'logs.md'))));
  assert.ok(report.issues.some((issue) => issue.kind === 'unexpected-knowledge-note' && issue.path.endsWith(path.join('04_Knowledge_Base', 'demo.md'))));
  assert.ok(report.issues.some((issue) => issue.kind === 'vault-artifact' && issue.path.endsWith('.DS_Store')));
  assert.ok(report.issues.some((issue) => issue.kind === 'broken-link' && issue.path.endsWith(path.join('01_Projects', 'demo', 'learnings.md'))));
  assert.ok(!report.issues.some((issue) => issue.path.endsWith(path.join('04_Knowledge_Base', 'documentation-style-patterns.md'))));
});

test('state normalization removes legacy query references to deprecated vault surfaces', () => {
  const config = {
    projectsRoot: '/tmp/projects',
    vaultRoot: '/tmp/vault',
    collectionName: 'brain_memory',
    watchMode: 'auto',
    pollIntervalMs: 60000,
  };

  const state = normalizeState(config, {
    projects: {},
    queryHistory: [
      {
        at: '2026-04-12T00:00:00.000Z',
        query: 'reusable pattern',
        mode: 'local-only',
        relatedProjects: ['brain'],
        topResultIds: [
          'brain:overview:/tmp/vault/01_Projects/brain/overview.md',
          'brain:knowledge:/tmp/vault/04_Knowledge_Base/documentation-style-patterns.md',
          'brain:knowledge:/tmp/vault/04_Knowledge_Base/brain.md',
          'brain:logs:/tmp/vault/01_Projects/brain/logs.md',
        ],
      },
    ],
  });

  assert.deepEqual(state.queryHistory[0].topResultIds, [
    'brain:overview:/tmp/vault/01_Projects/brain/overview.md',
    'brain:knowledge:/tmp/vault/04_Knowledge_Base/documentation-style-patterns.md',
  ]);
});

test('recordMemoryUsage promotes repeated normalized-project hits into one candidate and suppresses canonical duplicates', () => {
  const config = {
    projectsRoot: '/tmp/projects',
    vaultRoot: '/tmp/vault',
    collectionName: 'brain_memory',
    watchMode: 'auto',
    pollIntervalMs: 60000,
  };

  const state = normalizeState(config, {});
  const queryPhrases = [
    'retry boundary placement',
    'safe change retry wrapper',
    'shared client retry logic',
    'shared client timeout retries',
  ];

  for (const query of queryPhrases) {
    recordMemoryUsage(state, {
      source: 'query',
      query,
      currentProjectName: 'brain',
      mode: 'local-only',
      results: [
        {
          project: 'brain',
          noteType: 'normalized-project',
          sourcePath: '/tmp/projects/brain',
          sourceKind: 'project',
          snippet: 'Shared retry wrapper sits at the outbound client boundary.',
          relevanceScore: 0.82,
          evidenceQuality: 'strong',
          confidence: 0.9,
          supportCount: 1,
        },
        {
          project: 'brain',
          noteType: 'learnings',
          sourcePath: '/tmp/vault/01_Projects/brain/learnings.md',
          sourceKind: 'note',
          snippet: 'Place retry behavior at the shared client boundary.',
          relevanceScore: 0.8,
          evidenceQuality: 'strong',
          confidence: 0.88,
          supportCount: 1,
        },
      ],
    }, { config });
  }

  const summary = summarizeMemoryAdmission(state, config);
  assert.equal(summary.candidateCount, 1);
  assert.equal(summary.suppressedCanonicalCount, 1);
  assert.equal(summary.suppressedDuplicateCount, 1);
  assert.ok(summary.topCandidates[0].targetPath.endsWith(path.join('01_Projects', 'brain', 'learnings.md')));
});

test('getLastLearningActivityAt falls back to capture-learning operations when lastLearnAt is null', () => {
  const state = normalizeState({ projectsRoot: '/tmp/projects' }, {});
  state.operations = [
    {
      at: '2026-04-15T10:12:42.503Z',
      type: 'capture-learning',
      summary: 'Captured learning for brain: audit note',
    },
  ];

  assert.equal(getLastLearningActivityAt(state), '2026-04-15T10:12:42.503Z');
});

test('cleanupDeprecatedVaultArtifacts only reports paths that actually existed', async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), 'brain-cleanup-'));
  TEMP_PATHS.push(vaultRoot);
  await mkdir(path.join(vaultRoot, '01_Projects', 'demo'), { recursive: true });
  await mkdir(path.join(vaultRoot, '04_Knowledge_Base'), { recursive: true });
  const logsPath = path.join(vaultRoot, '01_Projects', 'demo', 'logs.md');
  await writeFile(logsPath, '# demo Logs\n', 'utf8');

  const removed = await cleanupDeprecatedVaultArtifacts(vaultRoot, ['demo']);

  assert.deepEqual(removed, [logsPath]);
});

test('MCP tool contract stays stable for Copilot integration', () => {
  assert.deepEqual(BRAIN_MCP_TOOL_NAMES, [
    'brain.search',
    'brain.consult',
    'brain.synthesize_guidance',
    'brain.project_summary',
    'brain.related_patterns',
    'brain.recent_learnings',
    'brain.capture_learning',
    'brain.capture_research_candidate',
  ]);
});

async function createRuntimeFixture(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  TEMP_PATHS.push(root);
  const projectsRoot = path.join(root, 'projects');
  const vaultRoot = path.join(root, 'vault');
  const dataRoot = path.join(root, 'data');
  await mkdir(projectsRoot, { recursive: true });
  await mkdir(vaultRoot, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  return {
    root,
    projectsRoot,
    vaultRoot,
    dataRoot,
    runtimeOptions: {
      projectsRoot,
      vaultRoot,
      dataRoot,
      projectNames: ['sample'],
    },
  };
}

async function createSampleProject(projectRoot) {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, 'README.md'), [
    '# Sample Project',
    '',
    '- Source repositories are read-only inputs.',
    '- Keep runtime state under data/ instead of the knowledge vault.',
    '',
    '```bash',
    'npm run doctor',
    'npm run validate:vault',
    '```',
  ].join('\n'), 'utf8');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'sample',
    private: true,
    scripts: {
      doctor: 'node doctor.mjs',
      test: 'node --test',
      'validate:vault': 'node validate.mjs',
    },
  }, null, 2), 'utf8');
}

function createProjectStub(name) {
  return {
    id: `${name}-id`,
    slug: name,
    name,
    rootPath: `/tmp/${name}`,
    evidenceModelVersion: 'provenance-v1',
    fingerprint: `${name}-fingerprint`,
    parsedAt: '2026-04-12T00:00:00.000Z',
    normalizedAt: '2026-04-12T00:00:00.000Z',
    purpose: `${name} purpose`,
    summary: `${name} summary`,
    stack: ['JavaScript', 'Node.js'],
    languages: ['JavaScript'],
    architecture: ['Monorepo with separate app and package boundaries'],
    modules: ['apps', 'packages'],
    workflows: ['Automation-first workflow with scriptable local entrypoints.'],
    integrationSurfaces: ['Code entry surface: apps/cli/index.mjs'],
    boundaryRules: ['Source repositories are read-only inputs.'],
    validationSurfaces: ['Package script: doctor: node doctor.mjs'],
    recurringProblems: ['Repository memory should stay trustworthy instead of drifting into stale notes.'],
    reusableSolutions: ['Use modular folders and shared packages to separate reusable capabilities from product surfaces.'],
    documentationPatterns: ['Documentation layout pattern: keep the README as the public cover, then split architecture, operator, CLI, or troubleshooting guidance into focused docs.'],
    documentationQualitySignals: ['README exposes anchor navigation so the landing page stays fast to scan on GitHub.'],
    documentationQualityScore: 7,
    riskNotes: [],
    improvementIdeas: [],
    promptAnchors: [],
    documentationPaths: ['README.md', 'docs/ARCHITECTURE.md'],
    entryPoints: ['apps/cli/index.mjs'],
    sourceStats: {
      totalFilesScanned: 12,
      totalDirectoriesScanned: 4,
      codeFilesDetected: 6,
    },
    warnings: [],
    tags: ['project', 'documentation'],
    provenance: {
      purpose: null,
      architecture: [],
      modules: [],
      workflows: [],
      integrationSurfaces: [],
      boundaryRules: [],
      validationSurfaces: [],
      recurringProblems: [],
      reusableSolutions: [],
      documentationPatterns: [],
      documentationQualitySignals: [],
    },
    corpusText: `${name} corpus`,
    promptTemplateContext: {
      project: name,
      stack: ['JavaScript', 'Node.js'],
      architecture: ['Monorepo with separate app and package boundaries'],
      keyModules: ['apps', 'packages'],
    },
    noteTargets: {
      overview: `01_Projects/${name}/overview.md`,
      architecture: `01_Projects/${name}/architecture.md`,
      learnings: `01_Projects/${name}/learnings.md`,
      prompts: `01_Projects/${name}/prompts.md`,
      knowledge: '04_Knowledge_Base/reusable-patterns.md',
      documentationStyle: '04_Knowledge_Base/documentation-style-patterns.md',
    },
    analysis: {},
  };
}
