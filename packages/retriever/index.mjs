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

const DOCUMENTATION_QUERY_TERMS = new Set(['readme', 'docs', 'documentation', 'architecture', 'guide', 'guidance', 'agent', 'agents', 'copilot', 'prompt', 'prompts', 'onboarding', 'github']);
const DEBUG_QUERY_TERMS = new Set(['bug', 'issue', 'error', 'failure', 'fail', 'debug', 'fix', 'broken', 'retry', 'retries', 'timeout', 'timeouts', 'reconnect']);
const BOUNDARY_QUERY_TERMS = new Set(['boundary', 'boundaries', 'safe', 'validation', 'validate', 'contract', 'module', 'modules', 'interface', 'interfaces', 'entrypoint', 'operator', 'workflow', 'shared']);
const EVIDENCE_QUALITY_RANK = { weak: 1, medium: 2, strong: 3 };
const KNOWLEDGE_STRENGTH_RANK = { weak: 1, medium: 2, strong: 3 };

export async function retrieveContext({
  queryText,
  topK,
  embedder,
  vectorStore,
  currentProjectName = '',
  retrievalProfile = 'default',
}) {
  const normalizedTopK = Math.max(Number(topK ?? 6), 1);
  const { expandedQueryText, expansionTerms } = expandQueryText(queryText);
  const queryIntent = analyzeQueryIntent(queryText);
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
    retrievalProfile,
    expansionTerms,
    queryIntent,
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

function rankResults(queryText, rawResults, { topK, currentProjectName, retrievalProfile, expansionTerms, queryIntent }) {
  const ranked = new Map();
  for (const rawResult of rawResults) {
    const normalized = normalizeResult(queryText, rawResult, {
      currentProjectName,
      retrievalProfile,
      expansionTerms,
      queryIntent,
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
    .sort((left, right) => compareRankedResults(left, right, { currentProjectName }));
  return selectDiverseResults(sortedResults, { topK, currentProjectName, queryIntent, retrievalProfile });
}

function normalizeResult(queryText, result, { currentProjectName, retrievalProfile, expansionTerms, queryIntent }) {
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
  const trustScore = computeTrustScore({
    evidenceQuality,
    confidence,
    supportCount,
    knowledgeStrength,
  });
  const noteTypeBoost = resolveNoteTypeBoost({
    noteType,
    sourcePath,
    canonicalKnowledgeSource,
    queryIntent,
  });
  const currentProjectBoost = currentProjectName && project === currentProjectName
    ? resolveCurrentProjectWeight(retrievalProfile, queryIntent)
    : 0;
  const reusablePatternBoost = canonicalKnowledgeSource
    ? (retrievalProfile === 'cross-project-patterns' ? 0.16 : 0.1)
    : 0;
  const boundarySignalBoost = queryIntent?.boundaryAware && hasBoundarySignal(documentText) ? 0.05 : 0;
  const debuggingBoost = queryIntent?.debugging && hasDebugSignal(documentText) ? 0.04 : 0;
  const documentationBoost = queryIntent?.documentation && hasDocumentationSignal({ documentText, noteType, sourcePath }) ? 0.05 : 0;
  const decisionHistoryBoost = retrievalProfile === 'decision-history' && ['learnings', 'prompts', 'architecture'].includes(noteType) ? 0.08 : 0;
  const phraseBonus = computePhraseBonus(queryText, documentText, queryIntent);
  const trustBonus = trustScore * (queryIntent?.repoSpecific || queryIntent?.shortQuery ? 0.14 : 0.1);
  const weakCrossProjectPenalty = currentProjectName
    && project !== currentProjectName
    && (queryIntent?.repoSpecific || retrievalProfile === 'current-project-strict')
    && trustScore < 0.46
      ? (retrievalProfile === 'current-project-strict' ? 0.12 : 0.06)
      : 0;
  const relevanceScore = clamp((semanticScore * 0.48) + lexicalBonus + expansionBonus + phraseBonus + noteTypeBoost + currentProjectBoost + reusablePatternBoost + boundarySignalBoost + debuggingBoost + documentationBoost + decisionHistoryBoost + trustBonus - weakCrossProjectPenalty, 0, 1);
  const matchSignals = uniqueStrings([
    semanticScore >= 0.45 ? 'semantic similarity' : '',
    currentProjectBoost > 0 ? 'current project boost' : '',
    noteTypeBoost > 0 ? `${noteType} note priority` : '',
    reusablePatternBoost > 0 ? 'reusable knowledge boost' : '',
    boundarySignalBoost > 0 ? 'boundary signal boost' : '',
    debuggingBoost > 0 ? 'debugging signal boost' : '',
    documentationBoost > 0 ? 'documentation signal boost' : '',
    phraseBonus > 0 ? 'phrase match' : '',
    trustScore >= 0.7 ? 'high trust score' : '',
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
    trustScore: Number(trustScore.toFixed(4)),
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

function analyzeQueryIntent(queryText) {
  const normalizedQuery = String(queryText ?? '').trim();
  const tokens = tokenize(normalizedQuery);
  const lowerQuery = normalizedQuery.toLowerCase();
  return {
    repoSpecific: /(this repo|this project|current project|without breaking|safe place|safe extension point|existing pattern|shared client|shared wrapper|entrypoint|boundary|boundaries|module|operator|vault|workflow)/i.test(lowerQuery),
    debugging: tokens.some((token) => DEBUG_QUERY_TERMS.has(token)),
    documentation: tokens.some((token) => DOCUMENTATION_QUERY_TERMS.has(token)),
    boundaryAware: /(without breaking|safe place|boundary|contract|validation surface|safe change|shared client|shared wrapper)/i.test(lowerQuery)
      || tokens.some((token) => BOUNDARY_QUERY_TERMS.has(token)),
    shortQuery: tokens.length > 0 && tokens.length <= 4,
  };
}

function resolveNoteTypeBoost({ noteType, sourcePath, canonicalKnowledgeSource, queryIntent }) {
  let boost = canonicalKnowledgeSource ? 0.16 : (NOTE_TYPE_BOOSTS[noteType] ?? 0);
  if (queryIntent?.debugging && noteType === 'learnings') {
    boost += 0.04;
  }
  if (queryIntent?.documentation && /documentation-style-patterns/i.test(sourcePath)) {
    boost += 0.08;
  }
  if (queryIntent?.boundaryAware && noteType === 'prompts') {
    boost += 0.04;
  }
  return boost;
}

function computePhraseBonus(queryText, documentText, queryIntent) {
  const queryTokens = tokenize(queryText);
  if (queryTokens.length < 2) {
    return 0;
  }

  const normalizedDocument = String(documentText ?? '').toLowerCase().replace(/[^a-z0-9_\-\s]+/g, ' ');
  const normalizedQuery = queryTokens.join(' ');
  if (normalizedDocument.includes(normalizedQuery)) {
    return queryIntent?.shortQuery ? 0.1 : 0.07;
  }

  const phraseWindow = Math.min(queryTokens.length, 3);
  for (let size = phraseWindow; size >= 2; size -= 1) {
    for (let index = 0; index <= queryTokens.length - size; index += 1) {
      const phrase = queryTokens.slice(index, index + size).join(' ');
      if (normalizedDocument.includes(phrase)) {
        return queryIntent?.shortQuery ? 0.07 : 0.04;
      }
    }
  }

  return 0;
}

function computeTrustScore({ evidenceQuality, confidence, supportCount, knowledgeStrength }) {
  const evidenceScore = evidenceQuality === 'strong' ? 1 : (evidenceQuality === 'medium' ? 0.62 : 0.22);
  const structureScore = knowledgeStrength === 'strong' ? 1 : (knowledgeStrength === 'medium' ? 0.64 : 0.28);
  const confidenceScore = clamp(confidence, 0, 1);
  const supportScore = clamp(supportCount / 3, 0, 1);
  return clamp((evidenceScore * 0.38) + (confidenceScore * 0.32) + (supportScore * 0.18) + (structureScore * 0.12), 0, 1);
}

function compareRankedResults(left, right, { currentProjectName = '' } = {}) {
  const comparisons = [
    Number(right.relevanceScore ?? 0) - Number(left.relevanceScore ?? 0),
    Number(right.trustScore ?? 0) - Number(left.trustScore ?? 0),
    Number(Boolean(currentProjectName && right.project === currentProjectName)) - Number(Boolean(currentProjectName && left.project === currentProjectName)),
    Number(right.supportCount ?? 0) - Number(left.supportCount ?? 0),
    (EVIDENCE_QUALITY_RANK[right.evidenceQuality] ?? 0) - (EVIDENCE_QUALITY_RANK[left.evidenceQuality] ?? 0),
    (KNOWLEDGE_STRENGTH_RANK[right.knowledgeStrength] ?? 0) - (KNOWLEDGE_STRENGTH_RANK[left.knowledgeStrength] ?? 0),
    Number(right.semanticScore ?? 0) - Number(left.semanticScore ?? 0),
  ];

  for (const delta of comparisons) {
    if (delta !== 0) {
      return delta;
    }
  }

  return String(left.project ?? '')
    .localeCompare(String(right.project ?? ''))
    || String(left.noteType ?? '').localeCompare(String(right.noteType ?? ''))
    || String(left.sourcePath ?? '').localeCompare(String(right.sourcePath ?? ''))
    || String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

function isReusableKnowledgeSource(noteType, sourcePath) {
  return noteType === 'knowledge' && /04_Knowledge_Base\/(?:reusable-patterns|documentation-style-patterns)\.md$/i.test(String(sourcePath ?? '').replace(/\\/g, '/'));
}

function hasBoundarySignal(documentText) {
  return /(do not|must not|keep|preserve|avoid|validate|test|healthcheck|contract|boundary|constraint|read-only|local-first|runtime state|vault|repo-local|evidence|operator)/i.test(documentText);
}

function hasDebugSignal(documentText) {
  return /(bug|debug|failure|error|fix|root cause|retry|timeout|reconnect|diagnostic|incident|symptom)/i.test(documentText);
}

function hasDocumentationSignal({ documentText, noteType, sourcePath }) {
  return noteType === 'knowledge'
    || /(documentation|readme|architecture|operator guide|agent guidance|copilot|onboarding|troubleshooting|github surface)/i.test(String(documentText ?? ''))
    || /documentation-style-patterns|README\.md|ARCHITECTURE\.md|OPERATOR_GUIDE\.md|AGENTS\.md|copilot-instructions\.md/i.test(String(sourcePath ?? ''));
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
  if (matchSignals.includes('phrase match')) {
    reasons.push('matched a direct query phrase');
  }
  if (matchSignals.includes('query expansion match')) {
    reasons.push('matched related bug/debug terms from query expansion');
  }
  if (matchSignals.includes('boundary signal boost')) {
    reasons.push('aligned with a boundary or safe-change signal');
  }
  if (matchSignals.includes('debugging signal boost')) {
    reasons.push('aligned with a debugging or failure-mode signal');
  }
  if (matchSignals.includes('documentation signal boost')) {
    reasons.push('aligned with a documentation or repo-surface signal');
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
  const trustScore = computeTrustScore({ evidenceQuality, confidence, supportCount, knowledgeStrength });
  reasons.push(`trust score: ${Number(trustScore.toFixed(2))}`);
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

function selectDiverseResults(results, { topK, currentProjectName, queryIntent, retrievalProfile }) {
  if (!currentProjectName) {
    return results.slice(0, topK);
  }

  const selected = [];
  const seenIds = new Set();
  const currentProjectResults = results.filter((result) => result.project === currentProjectName);
  const crossProjectResults = results.filter((result) => result.project !== currentProjectName);
  const currentBest = currentProjectResults[0] ?? null;
  const crossBest = crossProjectResults.find((result) => shouldIncludeCrossProjectResult(result, currentBest, queryIntent)) ?? null;
  const preferredCurrentProjectCount = retrievalProfile === 'current-project-strict'
    ? Math.min(3, topK)
    : (queryIntent?.repoSpecific ? Math.min(2, topK) : 1);

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
      const selectedCurrentProjectCount = selected.filter((entry) => entry.project === currentProjectName).length;
      if (selectedCurrentProjectCount < preferredCurrentProjectCount
        && currentProjectResults.length >= preferredCurrentProjectCount
        && !shouldIncludeCrossProjectResult(result, currentBest, queryIntent)) {
        continue;
      }
      const selectedCrossProjectCount = selected.filter((entry) => entry.project !== currentProjectName).length;
      if (selectedCrossProjectCount >= (retrievalProfile === 'current-project-strict' ? 0 : (queryIntent?.repoSpecific ? 1 : 2))
        && result.relevanceScore < (queryIntent?.repoSpecific ? 0.62 : 0.58)
        && Number(result.trustScore ?? 0) < 0.7) {
        continue;
      }
      if (currentBest
        && result.relevanceScore + (queryIntent?.repoSpecific ? 0.04 : 0.08) < currentBest.relevanceScore
        && !shouldIncludeCrossProjectResult(result, currentBest, queryIntent)) {
        continue;
      }
    }
    pushResult(result);
  }

  return [...selected]
    .sort((left, right) => compareRankedResults(left, right, { currentProjectName }))
    .slice(0, topK);
}

function shouldIncludeCrossProjectResult(result, currentBest, queryIntent) {
  if (!result) {
    return false;
  }
  if (result.matchSignals.includes('reusable knowledge boost')) {
    return true;
  }
  if (result.evidenceQuality === 'strong' && Number(result.trustScore ?? 0) >= 0.7 && result.relevanceScore >= 0.48) {
    return true;
  }
  if (!currentBest) {
    return result.relevanceScore >= (queryIntent?.repoSpecific ? 0.58 : 0.52);
  }
  if (queryIntent?.repoSpecific) {
    return result.relevanceScore >= 0.68
      || (Number(result.trustScore ?? 0) >= 0.78 && result.relevanceScore + 0.02 >= currentBest.relevanceScore);
  }
  return result.relevanceScore >= 0.58
    || result.relevanceScore + 0.06 >= currentBest.relevanceScore
    || Number(result.trustScore ?? 0) >= 0.76;
}

function resolveCurrentProjectWeight(retrievalProfile, queryIntent) {
  if (retrievalProfile === 'current-project-strict') {
    return queryIntent?.repoSpecific ? 0.24 : 0.18;
  }
  if (retrievalProfile === 'current-project-plus-neighbors') {
    return queryIntent?.repoSpecific ? 0.2 : 0.14;
  }
  if (retrievalProfile === 'cross-project-patterns') {
    return queryIntent?.repoSpecific ? 0.12 : 0.08;
  }
  return queryIntent?.repoSpecific ? 0.18 : 0.12;
}
