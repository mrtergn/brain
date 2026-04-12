import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { buildResearchConsultation, synthesizeLocalAndExternalGuidance } from '../packages/research/index.mjs';
import { BRAIN_MCP_TOOL_NAMES } from '../apps/mcp-server/index.mjs';
import { chunkProjectKnowledge } from '../packages/chunker/index.mjs';
import { LocalSemanticEmbedder, shutdownEmbeddingService } from '../packages/embeddings/index.mjs';
import { writeQueryHistoryNote } from '../packages/obsidian-writer/index.mjs';
import { expandQueryText } from '../packages/retriever/index.mjs';
import { normalizeState } from '../packages/state-manager/index.mjs';
import { validateVaultContract } from '../packages/vault-contract/index.mjs';
import { analyzeProject } from '../scripts/ai-brain/lib/project-analysis.mjs';

const TEMP_PATHS = [];

after(async () => {
  await shutdownEmbeddingService();
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

test('query expansion adds related auth and retry terms for messy bug queries', () => {
  const expanded = expandQueryText('auth retry bug');
  assert.ok(expanded.expandedQueryText.includes('related concepts:'));
  assert.ok(expanded.expansionTerms.includes('authentication'));
  assert.ok(expanded.expansionTerms.includes('backoff'));
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
    'Track the query shapes that reliably produce useful recall.',
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
  assert.ok(updated.includes('## Strong retrieval topics'));
  assert.ok(updated.includes('BAHT deploy safety and monetization boundaries.'));
  assert.ok(updated.includes('## Weak retrieval topics'));
  assert.ok(updated.includes('safe place to change retry logic in brain'));
  assert.ok(updated.includes('## Projects Recalled Most Often'));
  assert.ok(!updated.includes('## Generated Context'));
  assert.ok(!updated.includes('<!-- BRAIN:GENERATED_START -->'));
});

test('vault validation flags deprecated project mirrors and legacy markers', async () => {
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
  await writeFile(path.join(vaultRoot, '01_Projects', 'demo', 'logs.md'), '# demo Logs\n', 'utf8');
  await writeFile(path.join(vaultRoot, '04_Knowledge_Base', 'documentation-style-patterns.md'), '# Documentation Style Patterns\n', 'utf8');
  await writeFile(path.join(vaultRoot, '04_Knowledge_Base', 'demo.md'), '# demo Knowledge\n', 'utf8');

  const report = await validateVaultContract(vaultRoot);

  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.kind === 'legacy-marker' && issue.path.endsWith(path.join('01_Projects', 'demo', 'overview.md'))));
  assert.ok(report.issues.some((issue) => issue.kind === 'unexpected-project-note' && issue.path.endsWith(path.join('01_Projects', 'demo', 'logs.md'))));
  assert.ok(report.issues.some((issue) => issue.kind === 'unexpected-knowledge-note' && issue.path.endsWith(path.join('04_Knowledge_Base', 'demo.md'))));
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