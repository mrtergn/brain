import path from 'node:path';

import { readText, truncate, uniqueStrings } from '../shared/index.mjs';

export async function reasonAboutQuery(config, state, retrievalResponse) {
  const { queryText, results } = retrievalResponse;
  const topResults = results.slice(0, 5);
  const relatedProjects = uniqueStrings(topResults.map((result) => result.project));
  const promptTemplate = await loadPromptTemplate(config, 'local-reasoner.md');
  const composedPrompt = renderPrompt(promptTemplate, queryText, topResults);

  if (topResults.length === 0) {
    return {
      mode: resolveReasonerMode(config),
      relatedProjects: [],
      solutionSuggestions: ['No matching memory chunks were found. Run brain:sync and brain:embed first, or broaden the query.'],
      patternLinks: [],
      lessons: [],
      improvementRecommendations: ['Expand the indexed notes or improve chunk coverage for this domain.'],
      composedPrompt,
    };
  }

  const solutionSuggestions = topResults.slice(0, 3).map((result) => {
    return `Start from ${result.project} (${result.noteType}) because it scored ${result.relevanceScore} and mentions: ${result.snippet}`;
  });

  const patternLinks = uniqueStrings(topResults.map((result) => `${result.project} -> ${result.noteType}`)).slice(0, 6);
  const lessons = topResults.slice(0, 4).map((result) => {
    return `Reuse the memory from ${result.project}/${result.noteType} before applying changes in a similar area.`;
  });

  const improvementRecommendations = buildImprovementRecommendations(state, relatedProjects);

  return {
    mode: resolveReasonerMode(config),
    relatedProjects,
    solutionSuggestions,
    patternLinks,
    lessons,
    improvementRecommendations,
    composedPrompt,
  };
}

function renderPrompt(template, queryText, results) {
  const evidence = results
    .map((result, index) => `${index + 1}. ${result.project}/${result.noteType} (${result.relevanceScore}) -> ${truncate(result.snippet, 220)}`)
    .join('\n');

  return template
    .replace('{{query}}', queryText)
    .replace('{{evidence}}', evidence || 'No retrieved evidence.');
}

function resolveReasonerMode(config) {
  if (config.localReasonerOnly) {
    return 'local-only';
  }
  return process.env.BRAIN_REASONER_PROVIDER ? `provider:${process.env.BRAIN_REASONER_PROVIDER}` : 'local-only';
}

function buildImprovementRecommendations(state, relatedProjects) {
  const recommendations = [];
  if ((state.failures ?? []).length > 0) {
    recommendations.push('Review recent failure notes before repeating a similar workflow.');
  }
  if (relatedProjects.length >= 2) {
    recommendations.push(`Cross-link reusable patterns across ${relatedProjects.join(', ')} inside the knowledge base.`);
  }
  if (recommendations.length === 0) {
    recommendations.push('Promote this query into a reusable note if it becomes a repeated engineering question.');
  }
  return recommendations;
}

async function loadPromptTemplate(config, fileName) {
  const templatePath = path.join(config.promptsRoot, fileName);
  return readText(templatePath, 'Query: {{query}}\n\nEvidence:\n{{evidence}}');
}