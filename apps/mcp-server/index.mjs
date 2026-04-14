#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  captureLearning,
  captureResearchCandidate,
  consultBrain,
  getProjectSummary,
  getRecentLearnings,
  getRelatedPatterns,
  searchBrain,
  synthesizeGuidance,
} from '../../packages/brain-service/index.mjs';
import { appendLog, buildLogPath, buildRuntimeConfig, parseArgs } from '../../packages/shared/index.mjs';

export const BRAIN_MCP_TOOL_NAMES = [
  'brain.search',
  'brain.consult',
  'brain.synthesize_guidance',
  'brain.project_summary',
  'brain.related_patterns',
  'brain.recent_learnings',
  'brain.capture_learning',
  'brain.capture_research_candidate',
];

const server = new McpServer({
  name: 'local-brain',
  version: '1.0.0',
}, {
  capabilities: {
    tools: {},
  },
});

server.registerTool('brain.search', {
  title: 'Brain Search',
  description: 'Semantic search for project memory, reusable knowledge, and recent learnings. Use this before non-trivial edits.',
  inputSchema: {
    query: z.string().min(1),
    current_project_path: z.string().optional(),
    current_project_name: z.string().optional(),
    top_k: z.number().int().min(1).max(12).optional(),
  },
  outputSchema: {
    query: z.string(),
    expandedQuery: z.string(),
    expansionTerms: z.array(z.string()),
    currentProjectName: z.string().nullable(),
    currentProjectPath: z.string().nullable(),
    results: z.array(z.object({
      project: z.string(),
      noteType: z.string(),
      sourcePath: z.string(),
      sourceKind: z.string(),
      relevanceScore: z.number(),
      whyMatched: z.string(),
      whyTrusted: z.string(),
      knowledgeType: z.string(),
      knowledgeStrength: z.string(),
      evidenceQuality: z.string(),
      confidence: z.number(),
      supportCount: z.number(),
      supportingSources: z.array(z.object({
        sourcePath: z.string(),
        sourceKind: z.string(),
        sourceSection: z.string().nullable(),
        excerpt: z.string(),
      })),
      derivedFrom: z.array(z.string()),
      evidenceSummary: z.string(),
      snippet: z.string(),
      matchedTerms: z.array(z.string()),
    })),
    reasoning: z.object({
      relatedProjects: z.array(z.string()),
      solutionSuggestions: z.array(z.string()),
      improvementRecommendations: z.array(z.string()),
    }),
    relatedPatterns: z.array(z.object({
      patternTitle: z.string(),
      explanation: z.string(),
      sourceProjects: z.array(z.string()),
      whereUsedBefore: z.array(z.string()),
      relevanceScore: z.number(),
    })),
    recentLearnings: z.array(z.object({
      type: z.string(),
      projectName: z.string().nullable(),
      title: z.string(),
      excerpt: z.string(),
      notePath: z.string(),
      updatedAt: z.string().nullable(),
    })),
  },
}, async ({ query, current_project_path, current_project_name, top_k }) => {
  const payload = await searchBrain({
    query,
    currentProjectPath: current_project_path,
    currentProjectName: current_project_name,
    topK: top_k,
  });

  return {
    structuredContent: payload,
    content: [
      {
        type: 'text',
        text: renderSearchText(payload),
      },
    ],
  };
});

server.registerTool('brain.consult', {
  title: 'Brain Consult',
  description: 'Local-first engineering consultation with explicit research decision logic. Call this first for coding, debugging, refactoring, architecture, migration, or best-practice work.',
  inputSchema: {
    query: z.string().min(1),
    current_project_path: z.string().optional(),
    current_project_name: z.string().optional(),
    top_k: z.number().int().min(1).max(12).optional(),
  },
  outputSchema: {
    query: z.string(),
    currentProjectName: z.string().nullable(),
    currentProjectPath: z.string().nullable(),
    mode: z.enum(['local-only', 'local-plus-web-assist', 'web-first-local-adaptation']),
    localConfidence: z.object({
      score: z.number(),
      level: z.enum(['low', 'medium', 'high']),
      summary: z.string(),
      strongSignals: z.array(z.string()),
      weakSignals: z.array(z.string()),
      gaps: z.array(z.string()),
    }),
    localContext: z.object({
      relatedProjects: z.array(z.string()),
      topLocalSuggestions: z.array(z.string()),
      projectPatterns: z.array(z.string()),
      evidenceBasis: z.array(z.string()),
      noteReferences: z.object({
        overview: z.string().nullable(),
        architecture: z.string().nullable(),
        learnings: z.string().nullable(),
        prompts: z.string().nullable(),
        knowledge: z.string().nullable(),
        documentationStyle: z.string().nullable(),
      }),
    }),
    researchDecision: z.object({
      needsWebResearch: z.boolean(),
      triggers: z.array(z.string()),
      rationale: z.array(z.string()),
      sourcePriority: z.array(z.string()),
    }),
    researchPlan: z.object({
      officialDocsFirst: z.boolean(),
      detectedTechnologies: z.array(z.string()),
      researchQuestions: z.array(z.string()),
      suggestedQueries: z.array(z.string()),
      sourceTargets: z.array(z.object({
        label: z.string(),
        tier: z.string(),
        reason: z.string(),
        suggestedDomains: z.array(z.string()),
      })),
    }),
    synthesis: z.object({
      whatLocalSuggests: z.array(z.string()),
      whatNeedsValidation: z.array(z.string()),
      recommendedProjectApproach: z.array(z.string()),
    }),
    memoryGuidance: z.object({
      suggestedLevel: z.enum(['level-a-ephemeral', 'level-b-candidate', 'level-c-proven-pattern']),
      writeBackRecommended: z.boolean(),
      writeBackTarget: z.string(),
      rationale: z.array(z.string()),
    }),
    trustSummary: z.object({
      localEvidenceQuality: z.enum(['weak', 'medium', 'strong']),
      strongestBasis: z.array(z.string()),
      weakerAreas: z.array(z.string()),
      usedExternalGuidance: z.boolean(),
      usedExternalGuidanceBecause: z.string().nullable(),
    }),
    evidence: z.object({
      topResults: z.array(z.object({
        project: z.string(),
        noteType: z.string(),
        sourcePath: z.string(),
        sourceKind: z.string(),
        relevanceScore: z.number(),
        whyMatched: z.string(),
        whyTrusted: z.string(),
        evidenceQuality: z.string(),
        confidence: z.number(),
        supportCount: z.number(),
        supportingSources: z.array(z.object({
          sourcePath: z.string(),
          sourceKind: z.string(),
          sourceSection: z.string().nullable(),
          excerpt: z.string(),
        })),
        snippet: z.string(),
      })),
      relatedPatterns: z.array(z.object({
        patternTitle: z.string(),
        explanation: z.string(),
        sourceProjects: z.array(z.string()),
        evidenceQuality: z.string(),
        confidence: z.number(),
        supportCount: z.number(),
        supportingEvidence: z.array(z.object({
          sourcePath: z.string(),
          sourceKind: z.string(),
          sourceSection: z.string().nullable(),
          excerpt: z.string(),
        })),
        whyTrusted: z.string(),
        relevanceScore: z.number(),
      })),
      recentLearnings: z.array(z.object({
        type: z.string(),
        projectName: z.string().nullable(),
        title: z.string(),
        excerpt: z.string(),
        notePath: z.string(),
        evidenceQuality: z.string(),
        confidence: z.number(),
        supportingSources: z.array(z.object({
          sourcePath: z.string(),
          sourceKind: z.string(),
          sourceSection: z.string().nullable(),
          excerpt: z.string(),
        })),
        updatedAt: z.string().nullable(),
      })),
    }),
    agentActions: z.array(z.string()),
  },
}, async ({ query, current_project_path, current_project_name, top_k }) => {
  const payload = await consultBrain({
    query,
    currentProjectPath: current_project_path,
    currentProjectName: current_project_name,
    topK: top_k,
  });

  return {
    structuredContent: payload,
    content: [
      {
        type: 'text',
        text: renderConsultationText(payload),
      },
    ],
  };
});

server.registerTool('brain.synthesize_guidance', {
  title: 'Brain Synthesize Guidance',
  description: 'Combine local brain context with authoritative external findings and return a project-adapted recommendation plus memory guidance.',
  inputSchema: {
    query: z.string().min(1),
    current_project_path: z.string().optional(),
    current_project_name: z.string().optional(),
    top_k: z.number().int().min(1).max(12).optional(),
    external_findings: z.array(z.object({
      source_label: z.string().min(1),
      source_tier: z.enum(['tier-1-official', 'tier-2-authoritative', 'tier-3-community']),
      url: z.string().optional(),
      version: z.string().optional(),
      guidance: z.string().min(1),
    })).min(1),
  },
  outputSchema: {
    query: z.string(),
    mode: z.enum(['local-only', 'local-plus-web-assist', 'web-first-local-adaptation']),
    currentProjectName: z.string().nullable(),
    currentProjectPath: z.string().nullable(),
    localConfidence: z.object({
      score: z.number(),
      level: z.enum(['low', 'medium', 'high']),
      summary: z.string(),
      strongSignals: z.array(z.string()),
      weakSignals: z.array(z.string()),
      gaps: z.array(z.string()),
    }).nullable(),
    localContext: z.object({
      whatLocalProjectsSuggest: z.array(z.string()),
      projectPatterns: z.array(z.string()),
      relatedProjects: z.array(z.string()),
    }),
    externalGuidance: z.object({
      highestAuthority: z.string(),
      findings: z.array(z.object({
        sourceLabel: z.string(),
        sourceTier: z.string(),
        url: z.string(),
        version: z.string(),
        guidance: z.string(),
      })),
    }),
    synthesis: z.object({
      whatLocalProjectsSuggest: z.array(z.string()),
      whatCurrentBestPracticeSuggests: z.array(z.string()),
      agreements: z.array(z.string()),
      differences: z.array(z.string()),
      recommendedImplementationForThisRepo: z.array(z.string()),
      implementationCautions: z.array(z.string()),
    }),
    memoryDecision: z.object({
      level: z.enum(['level-a-ephemeral', 'level-b-candidate', 'level-c-proven-pattern']),
      shouldCaptureCandidate: z.boolean(),
      shouldPromoteReusablePattern: z.boolean(),
      recommendedTarget: z.string(),
      suggestedTitle: z.string().nullable(),
      suggestedPattern: z.string().nullable(),
      rationale: z.array(z.string()),
    }),
    noteTargets: z.object({
      candidate: z.string(),
      projectLearnings: z.string().nullable(),
      reusablePatterns: z.string(),
    }),
  },
}, async ({ query, current_project_path, current_project_name, top_k, external_findings }) => {
  const payload = await synthesizeGuidance({
    query,
    currentProjectPath: current_project_path,
    currentProjectName: current_project_name,
    topK: top_k,
    externalFindings: external_findings,
  });

  return {
    structuredContent: payload,
    content: [
      {
        type: 'text',
        text: renderSynthesisText(payload),
      },
    ],
  };
});

server.registerTool('brain.project_summary', {
  title: 'Project Summary',
  description: 'Return the best available summary for the current project, including stack, architecture, reusable learnings, and documentation-style patterns.',
  inputSchema: {
    project_path: z.string().optional(),
    project_name: z.string().optional(),
  },
  outputSchema: {
    projectName: z.string(),
    projectPath: z.string(),
    purpose: z.string(),
    stack: z.array(z.string()),
    architecture: z.array(z.string()),
    boundaries: z.array(z.string()),
    validationSurfaces: z.array(z.string()),
    importantFiles: z.array(z.string()),
    importantModules: z.array(z.string()),
    relevantLearnings: z.object({
      problem: z.string(),
      solution: z.array(z.string()),
      whyItWorked: z.array(z.string()),
      reusablePattern: z.array(z.string()),
      followUp: z.array(z.string()),
      evidenceQuality: z.string(),
      confidence: z.number(),
      supportingSources: z.array(z.object({
        sourcePath: z.string(),
        sourceKind: z.string(),
        sourceSection: z.string().nullable(),
        excerpt: z.string(),
      })),
    }),
    projectPatterns: z.array(z.string()),
    documentationPatterns: z.array(z.string()),
    provenance: z.object({
      purpose: z.object({
        id: z.string(),
        category: z.string().nullable(),
        value: z.string(),
        confidence: z.number(),
        evidenceQuality: z.string(),
        derivedFrom: z.string(),
        supportCount: z.number(),
        sources: z.array(z.object({
          sourcePath: z.string(),
          sourceKind: z.string(),
          sourceSection: z.string().nullable(),
          excerpt: z.string(),
        })),
      }).nullable(),
      boundaries: z.array(z.object({
        id: z.string(),
        category: z.string().nullable(),
        value: z.string(),
        confidence: z.number(),
        evidenceQuality: z.string(),
        derivedFrom: z.string(),
        supportCount: z.number(),
        sources: z.array(z.object({
          sourcePath: z.string(),
          sourceKind: z.string(),
          sourceSection: z.string().nullable(),
          excerpt: z.string(),
        })),
      })),
      validationSurfaces: z.array(z.object({
        id: z.string(),
        category: z.string().nullable(),
        value: z.string(),
        confidence: z.number(),
        evidenceQuality: z.string(),
        derivedFrom: z.string(),
        supportCount: z.number(),
        sources: z.array(z.object({
          sourcePath: z.string(),
          sourceKind: z.string(),
          sourceSection: z.string().nullable(),
          excerpt: z.string(),
        })),
      })),
      reusableSolutions: z.array(z.object({
        id: z.string(),
        category: z.string().nullable(),
        value: z.string(),
        confidence: z.number(),
        evidenceQuality: z.string(),
        derivedFrom: z.string(),
        supportCount: z.number(),
        sources: z.array(z.object({
          sourcePath: z.string(),
          sourceKind: z.string(),
          sourceSection: z.string().nullable(),
          excerpt: z.string(),
        })),
      })),
      documentationPatterns: z.array(z.object({
        id: z.string(),
        category: z.string().nullable(),
        value: z.string(),
        confidence: z.number(),
        evidenceQuality: z.string(),
        derivedFrom: z.string(),
        supportCount: z.number(),
        sources: z.array(z.object({
          sourcePath: z.string(),
          sourceKind: z.string(),
          sourceSection: z.string().nullable(),
          excerpt: z.string(),
        })),
      })),
    }),
    noteReferences: z.object({
      overview: z.string(),
      architecture: z.string(),
      learnings: z.string(),
      prompts: z.string(),
      knowledge: z.string(),
      documentationStyle: z.string(),
    }),
    lastSyncedAt: z.string().nullable(),
  },
}, async ({ project_path, project_name }) => {
  const payload = await getProjectSummary({
    projectPath: project_path,
    projectName: project_name,
  });

  return {
    structuredContent: payload,
    content: [
      {
        type: 'text',
        text: renderProjectSummaryText(payload),
      },
    ],
  };
});

server.registerTool('brain.related_patterns', {
  title: 'Related Patterns',
  description: 'Return reusable patterns from the brain that are likely to help with the current task.',
  inputSchema: {
    query: z.string().min(1),
    current_project_name: z.string().optional(),
    top_k: z.number().int().min(1).max(10).optional(),
  },
  outputSchema: {
    query: z.string(),
    currentProjectName: z.string().nullable(),
    patterns: z.array(z.object({
      patternTitle: z.string(),
      explanation: z.string(),
      sourceProjects: z.array(z.string()),
      whereUsedBefore: z.array(z.string()),
      supportingEvidence: z.array(z.object({
        sourcePath: z.string(),
        sourceKind: z.string(),
        sourceSection: z.string().nullable(),
        excerpt: z.string(),
      })),
      evidenceQuality: z.string(),
      confidence: z.number(),
      supportCount: z.number(),
      whyTrusted: z.string(),
      relevanceScore: z.number(),
    })),
  },
}, async ({ query, current_project_name, top_k }) => {
  const payload = await getRelatedPatterns({
    query,
    currentProjectName: current_project_name,
    topK: top_k,
  });
  return {
    structuredContent: payload,
    content: [
      {
        type: 'text',
        text: renderPatternText(payload),
      },
    ],
  };
});

server.registerTool('brain.recent_learnings', {
  title: 'Recent Learnings',
  description: 'Return recent learnings, debugging notes, and reusable patterns that are likely useful for the current task.',
  inputSchema: {
    current_project_name: z.string().optional(),
    category: z.string().optional(),
    limit: z.number().int().min(1).max(12).optional(),
  },
  outputSchema: {
    currentProjectName: z.string().nullable(),
    category: z.string(),
    items: z.array(z.object({
      type: z.string(),
      projectName: z.string().nullable(),
      title: z.string(),
      excerpt: z.string(),
      notePath: z.string(),
      evidenceQuality: z.string(),
      confidence: z.number(),
      supportingSources: z.array(z.object({
        sourcePath: z.string(),
        sourceKind: z.string(),
        sourceSection: z.string().nullable(),
        excerpt: z.string(),
      })),
      updatedAt: z.string().nullable(),
    })),
  },
}, async ({ current_project_name, category, limit }) => {
  const payload = await getRecentLearnings({
    currentProjectName: current_project_name,
    category,
    limit,
  });
  return {
    structuredContent: payload,
    content: [
      {
        type: 'text',
        text: renderRecentLearningsText(payload),
      },
    ],
  };
});

server.registerTool('brain.capture_learning', {
  title: 'Capture Learning',
  description: 'Append a structured learning to the project learnings note and refresh local memory for that project.',
  inputSchema: {
    title: z.string().min(1),
    project_name: z.string().min(1),
    problem: z.string().min(1),
    context: z.string().min(1),
    solution: z.string().min(1),
    why_it_worked: z.string().min(1),
    reusable_pattern: z.string().min(1),
    tags: z.array(z.string()).optional(),
  },
  outputSchema: {
    projectName: z.string(),
    notePath: z.string(),
    embedded: z.boolean(),
    capturedAt: z.string(),
  },
}, async ({ title, project_name, problem, context, solution, why_it_worked, reusable_pattern, tags }) => {
  const payload = await captureLearning({
    title,
    projectName: project_name,
    problem,
    context,
    solution,
    whyItWorked: why_it_worked,
    reusablePattern: reusable_pattern,
    tags,
  });
  return {
    structuredContent: payload,
    content: [
      {
        type: 'text',
        text: `Captured learning for ${payload.projectName} at ${payload.notePath}. Embedded refresh: ${payload.embedded ? 'yes' : 'not needed'}.`,
      },
    ],
  };
});

server.registerTool('brain.capture_research_candidate', {
  title: 'Capture Research Candidate',
  description: 'Store a promising but not yet proven research finding in the controlled candidate note instead of permanent memory.',
  inputSchema: {
    title: z.string().min(1),
    query: z.string().min(1),
    finding: z.string().min(1),
    recommendation: z.string().min(1),
    why_it_matters: z.string().min(1),
    reuse_potential: z.enum(['medium', 'high']),
    source_quality: z.enum(['tier-1-official', 'tier-2-authoritative', 'tier-3-community']),
    sources: z.array(z.string()).optional(),
    project_name: z.string().optional(),
    promotion_criteria: z.string().optional(),
    tags: z.array(z.string()).optional(),
  },
  outputSchema: {
    notePath: z.string(),
    projectName: z.string().nullable(),
    embedded: z.boolean(),
    capturedAt: z.string(),
  },
}, async ({ title, query, finding, recommendation, why_it_matters, reuse_potential, source_quality, sources, project_name, promotion_criteria, tags }) => {
  const payload = await captureResearchCandidate({
    title,
    query,
    finding,
    recommendation,
    whyItMatters: why_it_matters,
    reusePotential: reuse_potential,
    sourceQuality: source_quality,
    sources,
    projectName: project_name,
    promotionCriteria: promotion_criteria,
    tags,
  });
  return {
    structuredContent: payload,
    content: [
      {
        type: 'text',
        text: `Captured research candidate at ${payload.notePath}. Embedded refresh: no; candidate notes stay outside permanent semantic memory until proven.`,
      },
    ],
  };
});

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = buildRuntimeConfig({
    configPath: args.config,
    projectsRoot: args['projects-root'],
    vaultRoot: args['vault-root'],
    dataRoot: args['data-root'],
    cacheRoot: args['cache-root'],
    chromaRoot: args['chroma-root'],
    logRoot: args['log-root'],
    statePath: args['state-path'],
    pythonExecutable: args.python,
  });

  if (args.healthcheck) {
    await appendLog(buildLogPath(config, 'brain-mcp.log'), `MCP healthcheck passed | vault=${config.vaultRoot} | data=${config.dataRoot}`);
    console.log('local-brain MCP server ready');
    console.log(`Tools: ${BRAIN_MCP_TOOL_NAMES.join(', ')}`);
    return;
  }

  await appendLog(buildLogPath(config, 'brain-mcp.log'), `Starting local-brain MCP server | vault=${config.vaultRoot} | data=${config.dataRoot}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function renderSearchText(payload) {
  const lines = [
    `Brain search for: ${payload.query}`,
    payload.currentProjectName ? `Current project: ${payload.currentProjectName}` : 'Current project: global search',
    '',
    'Top matches:',
  ];
  for (const result of payload.results.slice(0, 6)) {
    lines.push(`- ${result.project}/${result.noteType} | score=${result.relevanceScore} | ${result.whyMatched}`);
    lines.push(`  trust: ${result.whyTrusted}`);
    lines.push(`  ${result.snippet}`);
  }
  if (payload.relatedPatterns.length > 0) {
    lines.push('');
    lines.push('Related patterns:');
    for (const pattern of payload.relatedPatterns.slice(0, 3)) {
      lines.push(`- ${pattern.patternTitle} | projects: ${pattern.sourceProjects.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function renderConsultationText(payload) {
  const lines = [
    `Brain consultation for: ${payload.query}`,
    `Mode: ${payload.mode}`,
    `Local confidence: ${payload.localConfidence.score} (${payload.localConfidence.level})`,
    `Web research required: ${payload.researchDecision.needsWebResearch ? 'yes' : 'no'}`,
    '',
    'Why:',
  ];
  for (const reason of payload.researchDecision.rationale.slice(0, 4)) {
    lines.push(`- ${reason}`);
  }
  lines.push('');
  lines.push('Local signals:');
  for (const item of payload.synthesis.whatLocalSuggests.slice(0, 4)) {
    lines.push(`- ${item}`);
  }
  if (payload.trustSummary.strongestBasis.length > 0) {
    lines.push('');
    lines.push('Trust basis:');
    for (const item of payload.trustSummary.strongestBasis.slice(0, 3)) {
      lines.push(`- ${item}`);
    }
  }
  if (payload.researchDecision.needsWebResearch) {
    lines.push('');
    lines.push('Prioritize these sources:');
    for (const source of payload.researchPlan.sourceTargets.slice(0, 4)) {
      lines.push(`- ${source.tier} | ${source.label}`);
    }
  }
  lines.push('');
  lines.push('Recommended approach:');
  for (const step of payload.synthesis.recommendedProjectApproach.slice(0, 4)) {
    lines.push(`- ${step}`);
  }
  return lines.join('\n');
}

function renderSynthesisText(payload) {
  const lines = [
    `Synthesized guidance for: ${payload.query}`,
    `Mode: ${payload.mode}`,
    '',
    'Local projects suggest:',
  ];
  for (const item of payload.synthesis.whatLocalProjectsSuggest.slice(0, 4)) {
    lines.push(`- ${item}`);
  }
  lines.push('');
  lines.push('Current best practice suggests:');
  for (const item of payload.synthesis.whatCurrentBestPracticeSuggests.slice(0, 4)) {
    lines.push(`- ${item}`);
  }
  lines.push('');
  lines.push('Recommended implementation:');
  for (const item of payload.synthesis.recommendedImplementationForThisRepo.slice(0, 4)) {
    lines.push(`- ${item}`);
  }
  lines.push('');
  lines.push(`Memory decision: ${payload.memoryDecision.level}`);
  for (const item of payload.memoryDecision.rationale.slice(0, 3)) {
    lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

function renderProjectSummaryText(payload) {
  return [
    `${payload.projectName}`,
    `Purpose: ${payload.purpose}`,
    `Stack: ${payload.stack.join(', ')}`,
    `Architecture: ${payload.architecture.slice(0, 4).join('; ')}`,
    `Problem: ${payload.relevantLearnings.problem}`,
    `Reusable pattern: ${payload.relevantLearnings.reusablePattern.slice(0, 2).join('; ')}`,
    `Learning trust: ${payload.relevantLearnings.evidenceQuality} ${payload.relevantLearnings.confidence}`,
  ].join('\n');
}

function renderPatternText(payload) {
  const lines = [`Patterns for: ${payload.query}`];
  for (const pattern of payload.patterns) {
    lines.push(`- ${pattern.patternTitle} | score=${pattern.relevanceScore} | projects: ${pattern.sourceProjects.join(', ')} | trust: ${pattern.evidenceQuality} ${pattern.confidence}`);
  }
  return lines.join('\n');
}

function renderRecentLearningsText(payload) {
  const lines = [`Recent learnings (${payload.category})`];
  for (const item of payload.items) {
    lines.push(`- ${item.title} | ${item.excerpt} | trust: ${item.evidenceQuality} ${item.confidence}`);
  }
  return lines.join('\n');
}

const currentFilePath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main().catch(async (error) => {
    const config = buildRuntimeConfig();
    await appendLog(buildLogPath(config, 'brain-mcp.log'), `MCP server failed: ${error.message}`);
    console.error(error.message);
    process.exitCode = 1;
  });
}