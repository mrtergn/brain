import { parseStructuredMetadata } from '../provenance/index.mjs';
import { clamp, tokenize, truncate, uniqueStrings } from '../shared/index.mjs';

const NOTE_TYPE_BOOSTS = {
  learnings: 0.18,
  prompts: 0.1,
  architecture: 0.08,
  overview: 0.07,
  'normalized-project': 0.03,
};

const QUERY_EXPANSION_RULES = [
  {
    match: (tokens, text) => tokens.has('auth') || tokens.has('authentication') || tokens.has('login') || text.includes('sign in'),
    expansions: ['authentication', 'login', 'session', 'token', 'middleware'],
  },
  {
    match: (tokens) => tokens.has('token') || tokens.has('jwt') || tokens.has('refresh'),
    expansions: ['jwt', 'access token', 'refresh token', 'session refresh'],
  },
  {
    match: (tokens, text) => tokens.has('retry') || tokens.has('retries') || text.includes('rate limit') || tokens.has('reconnect'),
    expansions: ['backoff', 'transient failure', 'retry policy', 'reconnect'],
  },
  {
    match: (tokens) => tokens.has('logging') || tokens.has('logger') || tokens.has('logs') || tokens.has('observability'),
    expansions: ['logger', 'observability', 'trace', 'diagnostics'],
  },
  {
    match: (tokens) => tokens.has('middleware') || tokens.has('interceptor') || tokens.has('guard'),
    expansions: ['middleware', 'interceptor', 'request pipeline', 'guard'],
  },
  {
    match: (tokens) => tokens.has('websocket') || tokens.has('socket') || tokens.has('ws'),
    expansions: ['websocket', 'socket', 'reconnect', 'connection recovery'],
  },
  {
    match: (tokens) => tokens.has('bug') || tokens.has('issue') || tokens.has('error') || tokens.has('failure'),
    expansions: ['bugfix', 'debugging', 'failure mode', 'fix'],
  },
  {
    match: (tokens) => tokens.has('refactor') || tokens.has('cleanup'),
    expansions: ['refactor', 'restructure', 'cleanup', 'modularization'],
  },
  {
    match: (tokens, text) => tokens.has('readme') || tokens.has('docs') || tokens.has('documentation') || tokens.has('agents') || tokens.has('copilot') || text.includes('architecture doc') || text.includes('operator guide'),
    expansions: ['documentation', 'repo presentation', 'architecture doc', 'operator guide', 'github surface'],
  },
];

export async function retrieveContext({
  queryText,
  topK,
  embedder,
  vectorStore,
  currentProjectName = '',
}) {
  const normalizedTopK = Math.max(Number(topK ?? 6), 1);
  const { expandedQueryText, expansionTerms } = expandQueryText(queryText);
  const queryEmbedding = await embedder.embedText(expandedQueryText);

  const globalResponse = await vectorStore.query(queryEmbedding, { topK: Math.max(normalizedTopK * 4, 12) });
  const currentProjectResponse = currentProjectName
    ? await vectorStore.query(queryEmbedding, { topK: Math.max(normalizedTopK * 3, 8), where: { project: currentProjectName } })
    : { results: [] };

  const results = rankResults(queryText, [
    ...(globalResponse.results ?? []).map((result) => ({ ...result, origin: 'global' })),
    ...(currentProjectResponse.results ?? []).map((result) => ({ ...result, origin: 'current-project' })),
  ], {
    topK: normalizedTopK,
    currentProjectName,
    expansionTerms,
  });

  return {
    queryText,
    expandedQueryText,
    expansionTerms,
    queryEmbedding,
    results,
  };
}

export function expandQueryText(queryText) {
  const normalizedQuery = String(queryText ?? '').trim();
  const lowerText = normalizedQuery.toLowerCase();
  const tokens = new Set(tokenize(normalizedQuery));
  const expansionTerms = uniqueStrings(
    QUERY_EXPANSION_RULES
      .filter((rule) => rule.match(tokens, lowerText))
      .flatMap((rule) => rule.expansions)
      .filter((term) => !lowerText.includes(term.toLowerCase())),
  );

  return {
    expansionTerms,
    expandedQueryText: expansionTerms.length > 0
      ? `${normalizedQuery}\nrelated concepts: ${expansionTerms.join(', ')}`
      : normalizedQuery,
  };
}

function rankResults(queryText, rawResults, { topK, currentProjectName, expansionTerms }) {
  const ranked = new Map();
  for (const rawResult of rawResults) {
    const normalized = normalizeResult(queryText, rawResult, {
      currentProjectName,
      expansionTerms,
    });
    const existing = ranked.get(normalized.id);
    if (!existing || normalized.relevanceScore > existing.relevanceScore) {
      ranked.set(normalized.id, normalized);
      continue;
    }
    existing.matchSignals = uniqueStrings([...(existing.matchSignals ?? []), ...(normalized.matchSignals ?? [])]);
    existing.matchedTerms = uniqueStrings([...(existing.matchedTerms ?? []), ...(normalized.matchedTerms ?? [])]);
    existing.whyMatched = buildWhyMatched(existing.matchSignals, existing.matchedTerms);
  }

  const sortedResults = [...ranked.values()]
    .sort((left, right) => right.relevanceScore - left.relevanceScore);
  return selectDiverseResults(sortedResults, { topK, currentProjectName });
}

function normalizeResult(queryText, result, { currentProjectName, expansionTerms }) {
  const snippet = truncate((result.document ?? '').replace(/\s+/g, ' '), 280);
  const distance = Number(result.distance ?? 1);
  const queryTokens = new Set(tokenize(queryText));
  const documentText = result.document ?? '';
  const documentTokens = new Set(tokenize(documentText));
  const expansionTokens = new Set(expansionTerms.flatMap((term) => tokenize(term)));
  const matchedTerms = [...queryTokens].filter((token) => documentTokens.has(token));
  const matchedExpansionTerms = [...expansionTokens].filter((token) => documentTokens.has(token));
  const semanticScore = clamp(1 - distance, 0, 1);
  const lexicalBonus = computeLexicalBonus(queryTokens, documentTokens, 0.22);
  const expansionBonus = computeLexicalBonus(expansionTokens, documentTokens, 0.08);
  const noteType = result.metadata?.noteType ?? 'unknown';
  const project = result.metadata?.project ?? 'unknown';
  const sourcePath = result.metadata?.sourcePath ?? 'unknown';
  const sourceKind = result.metadata?.sourceKind ?? 'unknown';
  const knowledgeType = result.metadata?.knowledgeType ?? inferKnowledgeType(noteType, sourcePath);
  const knowledgeStrength = result.metadata?.knowledgeStrength ?? inferKnowledgeStrength(noteType);
  const evidenceQuality = normalizeEvidenceQuality(result.metadata?.evidenceQuality);
  const confidence = Number(result.metadata?.confidence ?? 0);
  const supportCount = Number(result.metadata?.supportCount ?? 0);
  const supportingSources = parseStructuredMetadata(result.metadata?.supportingSources, []);
  const derivedFrom = String(result.metadata?.derivedFrom ?? '').split(' | ').map((value) => value.trim()).filter(Boolean);
  const evidenceSummary = String(result.metadata?.evidenceSummary ?? '').trim();
  const canonicalKnowledgeSource = isReusableKnowledgeSource(noteType, sourcePath);
  const noteTypeBoost = canonicalKnowledgeSource ? 0.16 : (NOTE_TYPE_BOOSTS[noteType] ?? 0);
  const currentProjectBoost = currentProjectName && project === currentProjectName ? 0.12 : 0;
  const reusablePatternBoost = canonicalKnowledgeSource ? 0.1 : 0;
  const boundarySignalBoost = hasBoundarySignal(documentText) && matchedTerms.length > 0 ? 0.05 : 0;
  const evidenceQualityBoost = evidenceQuality === 'strong' ? 0.06 : (evidenceQuality === 'medium' ? 0.03 : 0);
  const knowledgeStrengthBoost = knowledgeStrength === 'strong' ? 0.05 : (knowledgeStrength === 'medium' ? 0.02 : 0);
  const supportCountBoost = Math.min(supportCount * 0.015, 0.05);
  const confidenceBoost = Math.min(clamp(confidence, 0, 1) * 0.04, 0.04);
  const relevanceScore = clamp((semanticScore * 0.54) + lexicalBonus + expansionBonus + noteTypeBoost + currentProjectBoost + reusablePatternBoost + boundarySignalBoost + evidenceQualityBoost + knowledgeStrengthBoost + supportCountBoost + confidenceBoost, 0, 1);
  const matchSignals = uniqueStrings([
    semanticScore >= 0.45 ? 'semantic similarity' : '',
    currentProjectBoost > 0 ? 'current project boost' : '',
    noteTypeBoost > 0 ? `${noteType} note priority` : '',
    reusablePatternBoost > 0 ? 'reusable knowledge boost' : '',
    boundarySignalBoost > 0 ? 'boundary signal boost' : '',
    evidenceQuality === 'strong' ? 'strong evidence quality' : '',
    knowledgeStrength === 'strong' ? 'strong knowledge structure' : '',
    supportCount >= 2 ? 'multi-source support' : '',
    result.origin === 'current-project' ? 'current project filtered search' : '',
    matchedExpansionTerms.length > 0 ? 'query expansion match' : '',
  ]);

  return {
    id: result.id,
    snippet,
    document: result.document ?? '',
    sourcePath,
    project,
    noteType,
    tags: result.metadata?.tags ?? [],
    distance,
    relevanceScore: Number(relevanceScore.toFixed(4)),
    semanticScore: Number(semanticScore.toFixed(4)),
    sourceKind,
    knowledgeType,
    knowledgeStrength,
    evidenceQuality,
    confidence: Number(clamp(confidence, 0, 1).toFixed(4)),
    supportCount,
    supportingSources,
    derivedFrom,
    evidenceSummary,
    matchedTerms: uniqueStrings([...matchedTerms, ...matchedExpansionTerms]),
    matchSignals,
    whyMatched: buildWhyMatched(matchSignals, uniqueStrings([...matchedTerms, ...matchedExpansionTerms])),
    whyTrusted: buildWhyTrusted({
      sourceKind,
      knowledgeType,
      knowledgeStrength,
      evidenceQuality,
      confidence,
      supportCount,
      evidenceSummary,
      supportingSources,
    }),
    metadata: result.metadata ?? {},
  };
}

function computeLexicalBonus(queryTokens, documentTokens, maxBonus) {
  if (queryTokens.size === 0 || documentTokens.size === 0) {
    return 0;
  }
  let matches = 0;
  for (const token of queryTokens) {
    if (documentTokens.has(token)) {
      matches += 1;
    }
  }
  return clamp((matches / Math.max(queryTokens.size, 1)) * maxBonus, 0, maxBonus);
}

function isReusableKnowledgeSource(noteType, sourcePath) {
  return noteType === 'knowledge' && /04_Knowledge_Base\/(?:reusable-patterns|documentation-style-patterns)\.md$/i.test(String(sourcePath ?? '').replace(/\\/g, '/'));
}

function hasBoundarySignal(documentText) {
  return /(do not|must not|keep|preserve|avoid|validate|test|healthcheck|contract|boundary|constraint|read-only|local-first|runtime state|vault|repo-local|evidence|operator)/i.test(documentText);
}

function buildWhyMatched(matchSignals, matchedTerms) {
  const reasons = [];
  if (matchSignals.includes('current project boost')) {
    reasons.push('same project as the current workspace');
  }
  if (matchSignals.includes('reusable knowledge boost')) {
    reasons.push('comes from reusable knowledge or pattern notes');
  }
  if (matchSignals.includes('semantic similarity')) {
    reasons.push('strong semantic similarity');
  }
  if (matchSignals.includes('query expansion match')) {
    reasons.push('matched related bug/debug terms from query expansion');
  }
  if (matchSignals.includes('strong evidence quality')) {
    reasons.push('backed by strong evidence quality');
  }
  if (matchSignals.includes('strong knowledge structure')) {
    reasons.push('comes from a strongly structured memory source');
  }
  if (matchSignals.includes('multi-source support')) {
    reasons.push('supported by multiple source traces');
  }
  if (matchedTerms.length > 0) {
    reasons.push(`matched terms: ${matchedTerms.slice(0, 6).join(', ')}`);
  }
  return reasons.join('; ') || 'matched the query semantically';
}

function buildWhyTrusted({ sourceKind, knowledgeType, knowledgeStrength, evidenceQuality, confidence, supportCount, evidenceSummary, supportingSources }) {
  const reasons = [];
  if (knowledgeType === 'proven-learning') {
    reasons.push('source is a structured learning note');
  } else if (knowledgeType === 'project-snapshot') {
    reasons.push('source is the normalized project snapshot');
  } else if (knowledgeType) {
    reasons.push(`source type: ${knowledgeType}`);
  }
  if (knowledgeStrength === 'strong') {
    reasons.push('knowledge structure is strong');
  }
  reasons.push(`evidence quality: ${evidenceQuality}`);
  reasons.push(`confidence: ${Number(clamp(confidence, 0, 1).toFixed(2))}`);
  if (supportCount > 0) {
    reasons.push(`support traces: ${supportCount}`);
  }
  if (supportingSources.length > 0) {
    const first = supportingSources[0];
    const location = [first.sourcePath, first.sourceSection].filter(Boolean).join(' > ');
    reasons.push(`nearest evidence: ${location}`);
  } else if (sourceKind && sourceKind !== 'unknown') {
    reasons.push(`source kind: ${sourceKind}`);
  }
  if (evidenceSummary) {
    reasons.push(evidenceSummary);
  }
  return reasons.join('; ');
}

function inferKnowledgeType(noteType, sourcePath) {
  if (noteType === 'learnings') {
    return 'proven-learning';
  }
  if (noteType === 'normalized-project') {
    return 'project-snapshot';
  }
  if (/documentation-style-patterns/i.test(sourcePath)) {
    return 'documentation-pattern-catalog';
  }
  if (/reusable-patterns/i.test(sourcePath)) {
    return 'pattern-catalog';
  }
  if (noteType === 'prompts') {
    return 'guidance-note';
  }
  if (noteType === 'architecture') {
    return 'architecture-note';
  }
  return 'project-note';
}

function inferKnowledgeStrength(noteType) {
  if (noteType === 'learnings') {
    return 'strong';
  }
  if (noteType === 'normalized-project' || noteType === 'architecture' || noteType === 'prompts') {
    return 'medium';
  }
  return 'weak';
}

function normalizeEvidenceQuality(value) {
  if (value === 'strong' || value === 'medium' || value === 'weak') {
    return value;
  }
  return 'weak';
}

function selectDiverseResults(results, { topK, currentProjectName }) {
  if (!currentProjectName) {
    return results.slice(0, topK);
  }

  const selected = [];
  const seenIds = new Set();
  const currentProjectResults = results.filter((result) => result.project === currentProjectName);
  const crossProjectResults = results.filter((result) => result.project !== currentProjectName);
  const currentBest = currentProjectResults[0] ?? null;
  const crossBest = crossProjectResults.find((result) => shouldIncludeCrossProjectResult(result, currentBest)) ?? null;

  const pushResult = (result) => {
    if (!result || seenIds.has(result.id) || selected.length >= topK) {
      return;
    }
    selected.push(result);
    seenIds.add(result.id);
  };

  pushResult(currentBest);
  pushResult(crossBest);

  for (const result of results) {
    if (result.project !== currentProjectName) {
      const selectedCrossProjectCount = selected.filter((entry) => entry.project !== currentProjectName).length;
      if (selectedCrossProjectCount >= 2 && result.relevanceScore < 0.58) {
        continue;
      }
      if (currentBest && result.relevanceScore + 0.08 < currentBest.relevanceScore && !result.matchSignals.includes('reusable knowledge boost')) {
        continue;
      }
    }
    pushResult(result);
  }

  return selected.slice(0, topK);
}

function shouldIncludeCrossProjectResult(result, currentBest) {
  if (!result) {
    return false;
  }
  if (result.matchSignals.includes('reusable knowledge boost')) {
    return true;
  }
  if (!currentBest) {
    return result.relevanceScore >= 0.52;
  }
  return result.relevanceScore >= 0.58 || result.relevanceScore + 0.06 >= currentBest.relevanceScore;
}