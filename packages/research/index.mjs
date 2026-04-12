import { clamp, tokenize, truncate, uniqueStrings } from '../shared/index.mjs';

export const CONSULTATION_MODES = {
  LOCAL_ONLY: 'local-only',
  LOCAL_PLUS_WEB_ASSIST: 'local-plus-web-assist',
  WEB_FIRST_LOCAL_ADAPTATION: 'web-first-local-adaptation',
};

export const MEMORY_LEVELS = {
  EPHEMERAL: 'level-a-ephemeral',
  CANDIDATE: 'level-b-candidate',
  PROVEN_PATTERN: 'level-c-proven-pattern',
};

const FAST_MOVING_TECHS = new Set([
  'next',
  'nextjs',
  'react',
  'vue',
  'nuxt',
  'angular',
  'tailwind',
  'vite',
  'tanstack',
  'playwright',
  'vitest',
  'jest',
  'fastapi',
  'langchain',
  'openai',
  'vercel',
]);

const OFFICIAL_SOURCE_HINTS = {
  react: {
    label: 'React official docs',
    tier: 'tier-1-official',
    reason: 'React guidance and API behavior should come from the primary framework docs.',
    suggestedDomains: ['react.dev'],
  },
  next: {
    label: 'Next.js official docs',
    tier: 'tier-1-official',
    reason: 'Next.js behavior changes quickly across versions, so official docs and upgrade guides should lead.',
    suggestedDomains: ['nextjs.org'],
  },
  nextjs: {
    label: 'Next.js official docs',
    tier: 'tier-1-official',
    reason: 'Next.js behavior changes quickly across versions, so official docs and upgrade guides should lead.',
    suggestedDomains: ['nextjs.org'],
  },
  vue: {
    label: 'Vue official docs',
    tier: 'tier-1-official',
    reason: 'Framework conventions and migration guidance should come from Vue docs first.',
    suggestedDomains: ['vuejs.org'],
  },
  nuxt: {
    label: 'Nuxt official docs',
    tier: 'tier-1-official',
    reason: 'Nuxt rendering, data fetching, and migration behavior should be checked against primary docs.',
    suggestedDomains: ['nuxt.com'],
  },
  angular: {
    label: 'Angular official docs',
    tier: 'tier-1-official',
    reason: 'Angular version changes and recommended patterns should be checked in official docs.',
    suggestedDomains: ['angular.dev'],
  },
  node: {
    label: 'Node.js official docs',
    tier: 'tier-1-official',
    reason: 'Runtime APIs and version-specific behavior should be confirmed in Node.js docs.',
    suggestedDomains: ['nodejs.org'],
  },
  nodejs: {
    label: 'Node.js official docs',
    tier: 'tier-1-official',
    reason: 'Runtime APIs and version-specific behavior should be confirmed in Node.js docs.',
    suggestedDomains: ['nodejs.org'],
  },
  typescript: {
    label: 'TypeScript official docs',
    tier: 'tier-1-official',
    reason: 'Language and compiler guidance should come from TypeScript docs and release notes.',
    suggestedDomains: ['typescriptlang.org'],
  },
  javascript: {
    label: 'MDN JavaScript reference',
    tier: 'tier-2-authoritative',
    reason: 'MDN is the strongest general reference for web-platform JavaScript behavior.',
    suggestedDomains: ['developer.mozilla.org'],
  },
  python: {
    label: 'Python official docs',
    tier: 'tier-1-official',
    reason: 'Language and stdlib usage should come from Python docs first.',
    suggestedDomains: ['docs.python.org'],
  },
  java: {
    label: 'Java official docs',
    tier: 'tier-1-official',
    reason: 'JDK APIs and version behavior should be confirmed in official Java docs.',
    suggestedDomains: ['docs.oracle.com', 'openjdk.org'],
  },
  spring: {
    label: 'Spring official docs',
    tier: 'tier-1-official',
    reason: 'Spring and Spring Boot usage and migration guidance should come from primary docs.',
    suggestedDomains: ['docs.spring.io'],
  },
  'spring-boot': {
    label: 'Spring Boot official docs',
    tier: 'tier-1-official',
    reason: 'Spring Boot migration and auto-configuration behavior should come from official docs.',
    suggestedDomains: ['docs.spring.io'],
  },
  express: {
    label: 'Express official docs',
    tier: 'tier-1-official',
    reason: 'Middleware and routing behavior should be checked in Express docs first.',
    suggestedDomains: ['expressjs.com'],
  },
  fastapi: {
    label: 'FastAPI official docs',
    tier: 'tier-1-official',
    reason: 'Validation, dependency injection, and auth patterns should come from FastAPI docs.',
    suggestedDomains: ['fastapi.tiangolo.com'],
  },
  django: {
    label: 'Django official docs',
    tier: 'tier-1-official',
    reason: 'Security and framework usage should come from Django docs first.',
    suggestedDomains: ['docs.djangoproject.com'],
  },
  flask: {
    label: 'Flask official docs',
    tier: 'tier-1-official',
    reason: 'Extension and app-structure guidance should come from Flask docs first.',
    suggestedDomains: ['flask.palletsprojects.com'],
  },
  docker: {
    label: 'Docker official docs',
    tier: 'tier-1-official',
    reason: 'Container behavior and deployment guidance should come from Docker docs first.',
    suggestedDomains: ['docs.docker.com'],
  },
  kubernetes: {
    label: 'Kubernetes official docs',
    tier: 'tier-1-official',
    reason: 'Deployment and configuration guidance should come from Kubernetes docs first.',
    suggestedDomains: ['kubernetes.io'],
  },
  postgresql: {
    label: 'PostgreSQL official docs',
    tier: 'tier-1-official',
    reason: 'Database behavior and migration details should come from PostgreSQL docs.',
    suggestedDomains: ['postgresql.org'],
  },
  redis: {
    label: 'Redis official docs',
    tier: 'tier-1-official',
    reason: 'Caching and client-behavior guidance should come from Redis docs first.',
    suggestedDomains: ['redis.io'],
  },
  tailwind: {
    label: 'Tailwind CSS docs',
    tier: 'tier-1-official',
    reason: 'Utility conventions and version changes should come from Tailwind docs.',
    suggestedDomains: ['tailwindcss.com'],
  },
  vite: {
    label: 'Vite official docs',
    tier: 'tier-1-official',
    reason: 'Bundler behavior and plugin guidance should come from Vite docs.',
    suggestedDomains: ['vite.dev'],
  },
  playwright: {
    label: 'Playwright official docs',
    tier: 'tier-1-official',
    reason: 'Testing APIs and browser automation guidance should come from Playwright docs.',
    suggestedDomains: ['playwright.dev'],
  },
  vitest: {
    label: 'Vitest official docs',
    tier: 'tier-1-official',
    reason: 'Testing APIs and migration details should come from Vitest docs.',
    suggestedDomains: ['vitest.dev'],
  },
  jest: {
    label: 'Jest official docs',
    tier: 'tier-1-official',
    reason: 'Testing APIs and migration details should come from Jest docs.',
    suggestedDomains: ['jestjs.io'],
  },
  oauth: {
    label: 'OAuth and OpenID guidance',
    tier: 'tier-1-official',
    reason: 'Auth and session guidance should be validated against standards or primary vendor docs.',
    suggestedDomains: ['oauth.net', 'openid.net', 'datatracker.ietf.org'],
  },
  oidc: {
    label: 'OAuth and OpenID guidance',
    tier: 'tier-1-official',
    reason: 'OIDC behavior should be validated against standards or primary vendor docs.',
    suggestedDomains: ['openid.net', 'datatracker.ietf.org'],
  },
  jwt: {
    label: 'JWT standard reference',
    tier: 'tier-1-official',
    reason: 'Token format and security behavior should be validated against the standard.',
    suggestedDomains: ['datatracker.ietf.org'],
  },
  axios: {
    label: 'Axios official docs',
    tier: 'tier-1-official',
    reason: 'Interceptor and retry-adjacent client behavior should come from Axios docs.',
    suggestedDomains: ['axios-http.com'],
  },
  tanstack: {
    label: 'TanStack official docs',
    tier: 'tier-1-official',
    reason: 'Caching, retry, and data-fetching behavior should come from TanStack docs.',
    suggestedDomains: ['tanstack.com'],
  },
};

const THEME_RULES = [
  { key: 'single-flight token refresh', pattern: /(single[-\s]?flight|queued request replay|refresh storm|dedupe refresh|one refresh at a time)/i },
  { key: 'centralized retry boundary', pattern: /(shared http client|shared client boundary|boundary wrapper|centralized retry|central retry wrapper|shared retry policy|transport layer|interceptor)/i },
  { key: 'idempotent exponential backoff', pattern: /(idempotent|exponential backoff|backoff with jitter|retry only safe requests|transient failure)/i },
  { key: 'official migration path', pattern: /(migration guide|upgrade guide|breaking change|deprecated|deprecation|release notes)/i },
  { key: 'auth/session hardening', pattern: /(session|refresh token|httpOnly|secure cookie|csrf|rotate token|token refresh)/i },
  { key: 'boundary validation', pattern: /(input validation|schema validation|boundary validation|request validation|error handling)/i },
  { key: 'shared cache strategy', pattern: /(cache|stale|revalidate|cache invalidation|dedupe)/i },
  { key: 'integration test coverage', pattern: /(integration test|contract test|end-to-end|e2e|smoke test)/i },
];

export function buildResearchConsultation({
  query,
  currentProjectName,
  currentProjectPath,
  retrievalResponse,
  reasoning,
  projectSummary,
  relatedPatterns,
  recentLearnings,
} = {}) {
  const normalizedQuery = String(query ?? '').trim();
  const localConfidence = scoreLocalConfidence({
    retrievalResponse,
    currentProjectName,
    projectSummary,
  });
  const signals = detectResearchSignals({
    query: normalizedQuery,
    projectSummary,
    localConfidence,
  });
  const mode = decideConsultationMode({
    signals,
    localConfidence,
  });
  const localContext = buildLocalContext({
    retrievalResponse,
    reasoning,
    projectSummary,
    relatedPatterns,
  });
  const researchPlan = buildResearchPlan({
    query: normalizedQuery,
    signals,
    projectSummary,
    mode,
  });
  const synthesis = buildConsultationSynthesis({
    mode,
    signals,
    localContext,
    projectSummary,
  });
  const memoryGuidance = buildConsultationMemoryGuidance({
    mode,
    signals,
    localConfidence,
    localContext,
  });
  const researchDecision = {
    needsWebResearch: mode !== CONSULTATION_MODES.LOCAL_ONLY,
    triggers: signals.triggers,
    rationale: buildDecisionRationale({ mode, signals, localConfidence }),
    sourcePriority: researchPlan.sourceTargets.map((target) => `${target.tier}: ${target.label}`),
  };

  return {
    query: normalizedQuery,
    currentProjectName: currentProjectName ?? null,
    currentProjectPath: currentProjectPath ?? null,
    mode,
    localConfidence,
    localContext,
    researchDecision,
    researchPlan,
    synthesis,
    memoryGuidance,
    evidence: {
      topResults: (retrievalResponse?.results ?? []).slice(0, 5).map((result) => ({
        project: result.project,
        noteType: result.noteType,
        sourcePath: result.sourcePath,
        relevanceScore: result.relevanceScore,
        whyMatched: result.whyMatched,
        snippet: truncate(result.snippet ?? result.document ?? '', 220),
      })),
      relatedPatterns: (relatedPatterns ?? []).slice(0, 4).map((pattern) => ({
        patternTitle: pattern.patternTitle,
        explanation: pattern.explanation,
        sourceProjects: pattern.sourceProjects,
        relevanceScore: pattern.relevanceScore,
      })),
      recentLearnings: (recentLearnings ?? []).slice(0, 4),
    },
    agentActions: buildAgentActions({
      mode,
      localContext,
      researchPlan,
      memoryGuidance,
    }),
  };
}

export function synthesizeLocalAndExternalGuidance({ consultation, externalFindings, noteTargets } = {}) {
  const normalizedFindings = normalizeExternalFindings(externalFindings ?? []);
  const localThemes = extractThemes([
    ...(consultation?.synthesis?.whatLocalSuggests ?? []),
    ...(consultation?.localContext?.topLocalSuggestions ?? []),
    ...(consultation?.localContext?.projectPatterns ?? []),
  ]);
  const externalThemes = extractThemes(normalizedFindings.map((finding) => finding.guidance));
  const agreementThemes = [...localThemes].filter((theme) => externalThemes.has(theme));
  const externalOnlyThemes = [...externalThemes].filter((theme) => !localThemes.has(theme));
  const localOnlyThemes = [...localThemes].filter((theme) => !externalThemes.has(theme));
  const recommendedImplementationForThisRepo = buildRecommendedImplementation({
    consultation,
    agreementThemes,
    externalOnlyThemes,
    localOnlyThemes,
  });
  const implementationCautions = buildImplementationCautions({
    consultation,
    normalizedFindings,
    externalOnlyThemes,
  });
  const memoryDecision = buildSynthesisMemoryDecision({
    consultation,
    normalizedFindings,
    agreementThemes,
    externalOnlyThemes,
  });

  return {
    query: consultation?.query ?? '',
    mode: consultation?.mode ?? CONSULTATION_MODES.LOCAL_ONLY,
    currentProjectName: consultation?.currentProjectName ?? null,
    currentProjectPath: consultation?.currentProjectPath ?? null,
    localConfidence: consultation?.localConfidence ?? null,
    localContext: {
      whatLocalProjectsSuggest: consultation?.synthesis?.whatLocalSuggests ?? [],
      projectPatterns: consultation?.localContext?.projectPatterns ?? [],
      relatedProjects: consultation?.localContext?.relatedProjects ?? [],
    },
    externalGuidance: {
      highestAuthority: normalizedFindings[0]?.sourceTier ?? 'none',
      findings: normalizedFindings,
    },
    synthesis: {
      whatLocalProjectsSuggest: consultation?.synthesis?.whatLocalSuggests ?? [],
      whatCurrentBestPracticeSuggests: normalizedFindings.map((finding) => {
        return `${finding.sourceLabel} (${finding.sourceTier})${finding.version ? ` [${finding.version}]` : ''}: ${finding.guidance}`;
      }),
      agreements: agreementThemes.length > 0
        ? agreementThemes.map((theme) => `Local patterns and external guidance both support ${theme}.`)
        : ['No strong theme agreement was detected automatically; review the external findings directly.'],
      differences: [
        ...externalOnlyThemes.map((theme) => `External guidance adds ${theme}, which is not strongly represented in local memory yet.`),
        ...localOnlyThemes.map((theme) => `Local memory emphasizes ${theme}, but the supplied external findings did not confirm it directly.`),
      ].slice(0, 6),
      recommendedImplementationForThisRepo,
      implementationCautions,
    },
    memoryDecision,
    noteTargets,
  };
}

function scoreLocalConfidence({ retrievalResponse, currentProjectName, projectSummary } = {}) {
  const results = retrievalResponse?.results ?? [];
  const topScore = Number(results[0]?.relevanceScore ?? 0);
  const topThree = results.slice(0, 3);
  const averageTopScore = topThree.length > 0
    ? topThree.reduce((total, result) => total + Number(result.relevanceScore ?? 0), 0) / topThree.length
    : 0;
  const currentProjectHit = Boolean(currentProjectName && topThree.some((result) => result.project === currentProjectName));
  const reusableKnowledgeHit = topThree.some((result) => result.noteType === 'knowledge' || /(reusable-patterns|documentation-style-patterns)/i.test(result.sourcePath ?? ''));
  const matchedTerms = uniqueStrings(topThree.flatMap((result) => result.matchedTerms ?? []));

  let score = 0;
  score += results.length > 0 ? 0.18 : 0;
  score += clamp(topScore, 0, 1) * 0.34;
  score += clamp(averageTopScore, 0, 1) * 0.22;
  score += currentProjectHit ? 0.14 : 0;
  score += reusableKnowledgeHit ? 0.07 : 0;
  score += Math.min(matchedTerms.length * 0.02, 0.05);
  score += projectSummary ? 0.04 : 0;

  const normalizedScore = Number(clamp(score, 0, 1).toFixed(4));
  const level = normalizedScore >= 0.72 ? 'high' : normalizedScore >= 0.45 ? 'medium' : 'low';
  const strongSignals = [];
  const weakSignals = [];
  const gaps = [];

  if (topScore >= 0.72) {
    strongSignals.push('Top local match scored strongly against the query.');
  }
  if (averageTopScore >= 0.58) {
    strongSignals.push('Multiple local results agree, not just one isolated chunk.');
  }
  if (currentProjectHit) {
    strongSignals.push('The current project appears in the strongest local matches.');
  } else if (currentProjectName) {
    weakSignals.push('The current project is not strongly represented in the top local results.');
    gaps.push('Current-project evidence is weak, so any advice should be adapted carefully.');
  }
  if (reusableKnowledgeHit) {
    strongSignals.push('Reusable knowledge or pattern notes are present near the top of the results.');
  }
  if (results.length < 3) {
    weakSignals.push('The local brain returned only a shallow result set.');
    gaps.push('Local memory coverage is thin for this query.');
  }
  if (topScore < 0.45) {
    weakSignals.push('The best local semantic match is weak.');
    gaps.push('External validation is likely needed before implementation.');
  }
  if (matchedTerms.length < 2) {
    weakSignals.push('Few direct lexical matches were found in the top local chunks.');
  }

  const summary = level === 'high'
    ? 'Local memory has strong same-project or reusable-pattern coverage for this task.'
    : (level === 'medium'
      ? 'Local memory provides a usable starting point, but the answer may need external validation.'
      : 'Local memory is thin or indirect for this task, so external guidance should lead.');

  return {
    score: normalizedScore,
    level,
    summary,
    strongSignals: uniqueStrings(strongSignals),
    weakSignals: uniqueStrings(weakSignals),
    gaps: uniqueStrings(gaps),
  };
}

function detectResearchSignals({ query, projectSummary, localConfidence } = {}) {
  const queryText = String(query ?? '').trim();
  const lowerQuery = queryText.toLowerCase();
  const queryTokens = new Set(tokenize(queryText));
  const stackTokens = new Set((projectSummary?.stack ?? []).flatMap((item) => tokenize(item)));
  const allTokens = new Set([...queryTokens, ...stackTokens]);
  const technologies = uniqueStrings([...allTokens].filter((token) => OFFICIAL_SOURCE_HINTS[token]));
  const versionSpecific = /(\bv?\d+(?:\.\d+){0,2}\b)|\bversion\b|\bmajor\b|\bminor\b|\blts\b/i.test(lowerQuery);
  const currentGuidance = /best practice|current recommended|current guidance|latest|official docs|official guidance|recommended pattern|recommended approach/i.test(lowerQuery);
  const migration = /migrat|upgrade|breaking change|deprecated|deprecation|move from|move to|port to/i.test(lowerQuery);
  const securitySensitive = /auth|authentication|token|refresh|session|oauth|oidc|jwt|secret|cookie|csrf|security/i.test(lowerQuery);
  const resilience = /retry|retries|backoff|timeout|rate limit|reconnect|circuit breaker|transient/i.test(lowerQuery);
  const newLibraryUsage = /sdk|library|framework|integration|how to use|usage pattern|client\b|api reference|official api/i.test(lowerQuery);
  const testing = /test|testing|playwright|jest|vitest|pytest/i.test(lowerQuery);
  const fastMoving = technologies.some((token) => FAST_MOVING_TECHS.has(token)) || currentGuidance;

  const triggers = [];
  if (currentGuidance) {
    triggers.push('The query explicitly asks for current or recommended guidance.');
  }
  if (versionSpecific) {
    triggers.push('The query appears version-aware or version-sensitive.');
  }
  if (migration) {
    triggers.push('Migration and breaking-change work should be validated against official docs.');
  }
  if (securitySensitive) {
    triggers.push('The topic is auth/session/security sensitive.');
  }
  if (resilience) {
    triggers.push('The topic affects retry, backoff, or resilience behavior.');
  }
  if (newLibraryUsage) {
    triggers.push('The task looks like framework or library usage guidance.');
  }
  if (fastMoving) {
    triggers.push('The topic touches technology that changes quickly across versions.');
  }
  if (localConfidence?.level === 'low') {
    triggers.push('Local recall confidence is low.');
  }

  return {
    technologies,
    versionSpecific,
    currentGuidance,
    migration,
    securitySensitive,
    resilience,
    newLibraryUsage,
    testing,
    fastMoving,
    triggers: uniqueStrings(triggers),
  };
}

function decideConsultationMode({ signals, localConfidence } = {}) {
  const webFirst = signals?.migration
    || signals?.versionSpecific
    || (signals?.currentGuidance && (signals?.fastMoving || signals?.securitySensitive))
    || (signals?.securitySensitive && localConfidence?.level === 'low')
    || (signals?.newLibraryUsage && localConfidence?.level === 'low');

  if (webFirst) {
    return CONSULTATION_MODES.WEB_FIRST_LOCAL_ADAPTATION;
  }

  const webAssist = signals?.currentGuidance
    || signals?.securitySensitive
    || signals?.resilience
    || signals?.newLibraryUsage
    || signals?.fastMoving
    || localConfidence?.level === 'low';

  if (webAssist) {
    return CONSULTATION_MODES.LOCAL_PLUS_WEB_ASSIST;
  }

  return CONSULTATION_MODES.LOCAL_ONLY;
}

function buildLocalContext({ retrievalResponse, reasoning, projectSummary, relatedPatterns } = {}) {
  const topResults = (retrievalResponse?.results ?? []).slice(0, 4);
  const topLocalSuggestions = uniqueStrings([
    ...(projectSummary?.relevantLearnings?.solution ?? []).map((item) => `Current project solution signal: ${item}`),
    ...(projectSummary?.relevantLearnings?.reusablePattern ?? []).map((item) => `Current project reusable pattern: ${item}`),
    ...topResults.map((result) => `${result.project}/${result.noteType}: ${truncate(result.snippet ?? '', 150)}`),
    ...(reasoning?.improvementRecommendations ?? []).map((item) => `Follow-up: ${item}`),
  ]).slice(0, 6);

  return {
    relatedProjects: reasoning?.relatedProjects ?? [],
    topLocalSuggestions,
    projectPatterns: uniqueStrings([
      ...(projectSummary?.projectPatterns ?? []),
      ...(projectSummary?.documentationPatterns ?? []),
      ...(relatedPatterns ?? []).map((pattern) => pattern.patternTitle),
    ]).slice(0, 6),
    noteReferences: projectSummary?.noteReferences ?? {
      overview: null,
      architecture: null,
      learnings: null,
      prompts: null,
      knowledge: null,
      documentationStyle: null,
    },
  };
}

function buildResearchPlan({ query, signals, projectSummary, mode } = {}) {
  const sourceTargets = buildSourceTargets({ signals, projectSummary });
  const detectedTechnologies = signals?.technologies ?? [];
  const researchQuestions = uniqueStrings([
    signals?.securitySensitive ? 'What do official docs recommend for secure handling of this auth/session behavior in the target stack?' : '',
    signals?.migration ? 'What is the official migration path, including breaking changes and sequencing constraints?' : '',
    signals?.versionSpecific ? 'What changed in the target version, and which APIs or defaults are different?' : '',
    signals?.resilience ? 'What retry, timeout, or idempotency guidance does the primary framework or SDK recommend?' : '',
    signals?.newLibraryUsage ? 'What is the official usage pattern for this library or framework in production code?' : '',
    mode !== CONSULTATION_MODES.LOCAL_ONLY ? 'How should the external guidance be adapted to the current project boundaries and existing reusable patterns?' : '',
  ]).slice(0, 6);

  const suggestedQueries = uniqueStrings([
    query,
    ...detectedTechnologies.map((technology) => `${technology} ${query} official docs`),
    ...(signals?.migration ? detectedTechnologies.map((technology) => `${technology} ${query} migration guide`) : []),
    ...(signals?.securitySensitive ? detectedTechnologies.map((technology) => `${technology} ${query} security guidance`) : []),
    ...(signals?.versionSpecific ? detectedTechnologies.map((technology) => `${technology} ${query} release notes`) : []),
  ]).slice(0, 6);

  return {
    officialDocsFirst: mode !== CONSULTATION_MODES.LOCAL_ONLY,
    detectedTechnologies,
    researchQuestions,
    suggestedQueries,
    sourceTargets,
  };
}

function buildConsultationSynthesis({ mode, signals, localContext, projectSummary } = {}) {
  const whatLocalSuggests = uniqueStrings([
    ...localContext.topLocalSuggestions,
    ...(projectSummary?.relevantLearnings?.whyItWorked ?? []).map((item) => `Why it worked locally: ${item}`),
  ]).slice(0, 6);

  const whatNeedsValidation = uniqueStrings([
    signals?.currentGuidance ? 'Validate the answer against current official guidance instead of relying only on older local memory.' : '',
    signals?.migration ? 'Confirm the migration sequence, breaking changes, and any removed defaults.' : '',
    signals?.securitySensitive ? 'Confirm security-sensitive behavior against official guidance before implementation.' : '',
    signals?.versionSpecific ? 'Check version-specific API changes or defaults.' : '',
    signals?.resilience ? 'Validate retry safety, idempotency, and backoff details from authoritative sources.' : '',
  ]).slice(0, 5);

  const recommendedProjectApproach = [];
  const leadPattern = localContext.projectPatterns[0] ?? projectSummary?.relevantLearnings?.reusablePattern?.[0] ?? '';
  if (mode === CONSULTATION_MODES.LOCAL_ONLY) {
    recommendedProjectApproach.push(leadPattern
      ? `Start from the existing local pattern: ${leadPattern}`
      : 'Start from the strongest current-project learning and avoid adding a new pattern unless the codebase demands it.');
    recommendedProjectApproach.push('Use the local brain as the source of truth for repo-specific boundaries, naming, and module organization.');
  } else if (mode === CONSULTATION_MODES.LOCAL_PLUS_WEB_ASSIST) {
    recommendedProjectApproach.push(leadPattern
      ? `Reuse the local pattern first, then validate it against official guidance: ${leadPattern}`
      : 'Use local architecture notes to anchor the implementation, then validate the remaining gaps with official docs.');
    recommendedProjectApproach.push('Prefer official docs, migration guides, and security references before any community source.');
  } else {
    recommendedProjectApproach.push('Fetch authoritative guidance first, because the topic is current, version-sensitive, or security-critical.');
    recommendedProjectApproach.push(leadPattern
      ? `Adapt the external guidance to the project’s existing pattern instead of copying examples literally: ${leadPattern}`
      : 'After research, adapt the result to the project’s current boundaries and shared wrappers rather than scattering new logic.');
  }

  return {
    whatLocalSuggests,
    whatNeedsValidation,
    recommendedProjectApproach,
  };
}

function buildConsultationMemoryGuidance({ mode, signals, localConfidence, localContext } = {}) {
  const candidateWorthy = Boolean(signals?.securitySensitive || signals?.resilience || signals?.migration || signals?.newLibraryUsage);
  const suggestedLevel = mode === CONSULTATION_MODES.LOCAL_ONLY
    ? MEMORY_LEVELS.EPHEMERAL
    : (candidateWorthy ? MEMORY_LEVELS.CANDIDATE : MEMORY_LEVELS.EPHEMERAL);

  return {
    suggestedLevel,
    writeBackRecommended: candidateWorthy && localConfidence?.level !== 'high',
    writeBackTarget: candidateWorthy ? '03_Agent_Notes/research-candidates.md' : 'none',
    rationale: uniqueStrings([
      mode === CONSULTATION_MODES.LOCAL_ONLY ? 'This looks like a repo-shaped task; keep the answer local unless the implementation proves broadly reusable.' : '',
      candidateWorthy ? 'If research yields a reusable but not yet proven implementation pattern, store it as a research candidate instead of permanent memory.' : '',
      localContext?.projectPatterns?.length > 0 ? 'Existing local patterns should still anchor the implementation even when research is needed.' : '',
    ]).slice(0, 4),
  };
}

function buildDecisionRationale({ mode, signals, localConfidence } = {}) {
  const reasons = [];
  if (mode === CONSULTATION_MODES.LOCAL_ONLY) {
    reasons.push('Local confidence is high enough that repo memory should lead the implementation.');
  }
  if (signals?.currentGuidance) {
    reasons.push('The query explicitly asks for up-to-date or recommended practice.');
  }
  if (signals?.migration || signals?.versionSpecific) {
    reasons.push('Version or migration-sensitive behavior should be validated against official docs.');
  }
  if (signals?.securitySensitive) {
    reasons.push('Security-sensitive code should not rely on stale local memory alone.');
  }
  if (localConfidence?.level === 'low') {
    reasons.push('Local recall confidence is low, so external guidance needs to carry more weight.');
  }
  return uniqueStrings(reasons).slice(0, 5);
}

function buildSourceTargets({ signals, projectSummary } = {}) {
  const technologies = signals?.technologies ?? [];
  const targets = [];
  for (const technology of technologies) {
    const hint = OFFICIAL_SOURCE_HINTS[technology];
    if (!hint) {
      continue;
    }
    targets.push(hint);
  }

  if (signals?.migration) {
    targets.push({
      label: 'Official migration guides and release notes',
      tier: 'tier-1-official',
      reason: 'Migration work should start with primary upgrade guides and release notes.',
      suggestedDomains: technologies.flatMap((technology) => OFFICIAL_SOURCE_HINTS[technology]?.suggestedDomains ?? []),
    });
  }
  if (signals?.securitySensitive) {
    targets.push({
      label: 'Official security and auth guidance',
      tier: 'tier-1-official',
      reason: 'Auth, session, token, and cookie behavior should be validated against primary guidance.',
      suggestedDomains: uniqueStrings([
        ...technologies.flatMap((technology) => OFFICIAL_SOURCE_HINTS[technology]?.suggestedDomains ?? []),
        'oauth.net',
        'openid.net',
        'datatracker.ietf.org',
      ]),
    });
  }
  if (signals?.resilience) {
    targets.push({
      label: 'Official client, transport, or framework docs',
      tier: 'tier-1-official',
      reason: 'Retry and resilience behavior should be checked against the runtime, client, or framework that actually performs the requests.',
      suggestedDomains: uniqueStrings(technologies.flatMap((technology) => OFFICIAL_SOURCE_HINTS[technology]?.suggestedDomains ?? [])),
    });
  }

  targets.push({
    label: 'Vendor engineering blogs or maintainer-authored references',
    tier: 'tier-2-authoritative',
    reason: 'Use these only after the primary docs if the official guidance is incomplete or too abstract.',
    suggestedDomains: [],
  });
  targets.push({
    label: 'GitHub issues, discussions, or Stack Overflow',
    tier: 'tier-3-community',
    reason: 'Use only when official and authoritative sources do not address the exact failure mode.',
    suggestedDomains: ['github.com', 'stackoverflow.com'],
  });

  const stackFallbacks = (projectSummary?.stack ?? [])
    .flatMap((item) => tokenize(item))
    .filter((token) => OFFICIAL_SOURCE_HINTS[token]);

  const deduped = new Map();
  for (const target of [...targets, ...stackFallbacks.map((token) => OFFICIAL_SOURCE_HINTS[token])]) {
    const key = `${target.tier}:${target.label}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        ...target,
        suggestedDomains: uniqueStrings(target.suggestedDomains ?? []).slice(0, 6),
      });
    }
  }

  return [...deduped.values()].slice(0, 6);
}

function buildAgentActions({ mode, localContext, researchPlan, memoryGuidance } = {}) {
  const actions = [];
  const leadNote = localContext?.noteReferences?.learnings || localContext?.noteReferences?.architecture;
  if (leadNote) {
    actions.push(`Open the strongest local note first: ${leadNote}`);
  }
  if (mode !== CONSULTATION_MODES.LOCAL_ONLY) {
    actions.push('Fetch Tier 1 sources first and ignore weaker community sources unless the primary docs do not answer the question.');
    actions.push(`Use these research questions to stay focused: ${researchPlan?.researchQuestions?.slice(0, 2).join(' | ')}`);
  }
  actions.push('Synthesize local patterns with external guidance before proposing implementation details.');
  if (memoryGuidance?.writeBackRecommended) {
    actions.push(`If the result is promising but not yet proven, capture it in ${memoryGuidance.writeBackTarget} instead of permanent memory.`);
  }
  return actions.slice(0, 5);
}

function normalizeExternalFindings(findings) {
  return findings
    .map((finding) => ({
      sourceLabel: String(finding?.source_label ?? '').trim(),
      sourceTier: String(finding?.source_tier ?? '').trim(),
      url: String(finding?.url ?? '').trim(),
      version: String(finding?.version ?? '').trim(),
      guidance: truncate(String(finding?.guidance ?? '').trim(), 280),
    }))
    .filter((finding) => finding.sourceLabel && finding.sourceTier && finding.guidance)
    .sort((left, right) => sourceTierRank(left.sourceTier) - sourceTierRank(right.sourceTier));
}

function extractThemes(lines) {
  const themes = new Set();
  for (const line of lines) {
    const text = String(line ?? '');
    for (const rule of THEME_RULES) {
      if (rule.pattern.test(text)) {
        themes.add(rule.key);
      }
    }
  }
  return themes;
}

function buildRecommendedImplementation({ consultation, agreementThemes, externalOnlyThemes, localOnlyThemes } = {}) {
  const recommendations = [];
  const leadPattern = consultation?.localContext?.projectPatterns?.[0] ?? '';
  if (leadPattern) {
    recommendations.push(`Anchor the implementation in the project’s existing pattern: ${leadPattern}`);
  }
  if (agreementThemes.includes('single-flight token refresh')) {
    recommendations.push('Handle token refresh through a single-flight guard so concurrent requests do not create refresh storms.');
  }
  if (agreementThemes.includes('centralized retry boundary') || externalOnlyThemes.includes('centralized retry boundary')) {
    recommendations.push('Place retry behavior at the shared client or transport boundary instead of scattering retries across callers.');
  }
  if (agreementThemes.includes('idempotent exponential backoff') || externalOnlyThemes.includes('idempotent exponential backoff')) {
    recommendations.push('Retry only idempotent or explicitly safe operations, and apply exponential backoff with jitter.');
  }
  if (externalOnlyThemes.includes('official migration path')) {
    recommendations.push('Apply the migration in the sequence recommended by the official guide before adapting local wrappers or abstractions.');
  }
  if (recommendations.length === 0) {
    recommendations.push('Reuse the strongest local boundary pattern, then apply the external guidance only where local evidence is missing or outdated.');
  }
  if (localOnlyThemes.length > 0) {
    recommendations.push('Keep repo-specific naming, module boundaries, and ownership patterns aligned with the existing codebase rather than copying documentation examples literally.');
  }
  return uniqueStrings(recommendations).slice(0, 6);
}

function buildImplementationCautions({ consultation, normalizedFindings, externalOnlyThemes } = {}) {
  const cautions = [];
  if (normalizedFindings.some((finding) => finding.sourceTier === 'tier-3-community')) {
    cautions.push('Some external evidence is community-sourced; treat it as a fallback, not a primary decision maker.');
  }
  if (consultation?.localConfidence?.level === 'low') {
    cautions.push('Local memory coverage is weak here, so verify assumptions against the actual code before broad refactors.');
  }
  if (externalOnlyThemes.length > 0) {
    cautions.push('External guidance introduces themes that local memory does not yet reflect; capture them as candidates first unless implementation proves them repeatedly.');
  }
  if (cautions.length === 0) {
    cautions.push('No major caution flags were inferred; keep the implementation aligned with existing project boundaries.');
  }
  return cautions.slice(0, 4);
}

function buildSynthesisMemoryDecision({ consultation, normalizedFindings, agreementThemes, externalOnlyThemes } = {}) {
  const highestTier = normalizedFindings[0]?.sourceTier ?? 'tier-3-community';
  const reusableQuery = /(retry|retries|backoff|token|refresh|session|auth|migration|cache|validation|error handling|sdk)/i.test(consultation?.query ?? '');
  const strongAgreement = agreementThemes.length > 0 && highestTier !== 'tier-3-community';
  const shouldPromoteReusablePattern = reusableQuery && strongAgreement && consultation?.localConfidence?.level === 'high';
  const shouldCaptureCandidate = reusableQuery && (externalOnlyThemes.length > 0 || consultation?.localConfidence?.level !== 'high');
  const level = shouldPromoteReusablePattern
    ? MEMORY_LEVELS.PROVEN_PATTERN
    : (shouldCaptureCandidate ? MEMORY_LEVELS.CANDIDATE : MEMORY_LEVELS.EPHEMERAL);
  const suggestedPattern = buildSuggestedPattern(consultation?.query ?? '', agreementThemes, externalOnlyThemes);
  const recommendedTarget = shouldPromoteReusablePattern
    ? (consultation?.currentProjectName ? `01_Projects/${consultation.currentProjectName}/learnings.md or 04_Knowledge_Base/reusable-patterns.md` : '04_Knowledge_Base/reusable-patterns.md')
    : (shouldCaptureCandidate ? '03_Agent_Notes/research-candidates.md' : 'none');

  return {
    level,
    shouldCaptureCandidate,
    shouldPromoteReusablePattern,
    recommendedTarget,
    suggestedTitle: shouldCaptureCandidate || shouldPromoteReusablePattern ? buildSuggestedTitle(consultation?.query ?? '', suggestedPattern) : null,
    suggestedPattern: shouldCaptureCandidate || shouldPromoteReusablePattern ? suggestedPattern : null,
    rationale: uniqueStrings([
      shouldPromoteReusablePattern ? 'Local patterns and higher-authority external guidance agree strongly enough to suggest a reusable pattern.' : '',
      shouldCaptureCandidate ? 'The finding looks reusable, but it should be validated through implementation before permanent promotion.' : '',
      !shouldCaptureCandidate && !shouldPromoteReusablePattern ? 'Treat this research as task-local context unless it becomes repeatedly useful.' : '',
    ]).slice(0, 4),
  };
}

function buildSuggestedPattern(query, agreementThemes, externalOnlyThemes) {
  const themes = [...agreementThemes, ...externalOnlyThemes];
  if (themes.includes('single-flight token refresh')) {
    return 'Single-flight token refresh with queued request replay';
  }
  if (themes.includes('centralized retry boundary') || themes.includes('idempotent exponential backoff')) {
    return 'Central retry wrapper for outbound API clients';
  }
  if (themes.includes('official migration path')) {
    return 'Migration sequencing from official guides before local wrapper changes';
  }
  if (themes.includes('auth/session hardening')) {
    return 'Shared auth/session boundary with explicit refresh coordination';
  }
  return truncate(query, 96);
}

function buildSuggestedTitle(query, suggestedPattern) {
  if (suggestedPattern && suggestedPattern !== truncate(query, 96)) {
    return suggestedPattern;
  }
  return truncate(query, 96);
}

function sourceTierRank(tier) {
  if (tier === 'tier-1-official') {
    return 1;
  }
  if (tier === 'tier-2-authoritative') {
    return 2;
  }
  return 3;
}