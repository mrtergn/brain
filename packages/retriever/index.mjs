import { clamp, tokenize, truncate, uniqueStrings } from '../shared/index.mjs';

const NOTE_TYPE_BOOSTS = {
  learnings: 0.16,
  knowledge: 0.14,
  prompts: 0.08,
  architecture: 0.07,
  overview: 0.06,
  'normalized-project': 0.04,
  logs: 0.03,
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
  const noteTypeBoost = NOTE_TYPE_BOOSTS[noteType] ?? 0;
  const currentProjectBoost = currentProjectName && project === currentProjectName ? 0.18 : 0;
  const reusablePatternBoost = isReusableKnowledgeSource(noteType, sourcePath) ? 0.08 : 0;
  const relevanceScore = clamp((semanticScore * 0.68) + lexicalBonus + expansionBonus + noteTypeBoost + currentProjectBoost + reusablePatternBoost, 0, 1);
  const matchSignals = uniqueStrings([
    semanticScore >= 0.45 ? 'semantic similarity' : '',
    currentProjectBoost > 0 ? 'current project boost' : '',
    noteTypeBoost > 0 ? `${noteType} note priority` : '',
    reusablePatternBoost > 0 ? 'reusable knowledge boost' : '',
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
    matchedTerms: uniqueStrings([...matchedTerms, ...matchedExpansionTerms]),
    matchSignals,
    whyMatched: buildWhyMatched(matchSignals, uniqueStrings([...matchedTerms, ...matchedExpansionTerms])),
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
  return noteType === 'knowledge' || /04_Knowledge_Base|reusable-patterns/i.test(sourcePath);
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
  if (matchedTerms.length > 0) {
    reasons.push(`matched terms: ${matchedTerms.slice(0, 6).join(', ')}`);
  }
  return reasons.join('; ') || 'matched the query semantically';
}

function selectDiverseResults(results, { topK, currentProjectName }) {
  if (!currentProjectName) {
    return results.slice(0, topK);
  }

  const selected = [];
  const seenIds = new Set();
  const currentProjectResults = results.filter((result) => result.project === currentProjectName);
  const crossProjectResults = results.filter((result) => result.project !== currentProjectName);

  const pushResult = (result) => {
    if (!result || seenIds.has(result.id) || selected.length >= topK) {
      return;
    }
    selected.push(result);
    seenIds.add(result.id);
  };

  pushResult(currentProjectResults[0]);
  pushResult(crossProjectResults[0]);

  for (const result of results) {
    pushResult(result);
  }

  return selected.slice(0, topK);
}