import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createEvidenceItem,
  createEvidenceSource,
  EVIDENCE_MODEL_VERSION,
  evidenceItemsToValues,
  mergeEvidenceItems,
} from '../../../packages/provenance/index.mjs';

const SOURCE_EXTENSIONS = new Map([
  ['.ts', 'TypeScript'],
  ['.tsx', 'TypeScript'],
  ['.js', 'JavaScript'],
  ['.jsx', 'JavaScript'],
  ['.mjs', 'JavaScript'],
  ['.cjs', 'JavaScript'],
  ['.py', 'Python'],
  ['.go', 'Go'],
  ['.rs', 'Rust'],
  ['.java', 'Java'],
  ['.kt', 'Kotlin'],
  ['.dart', 'Dart'],
  ['.cs', '.NET'],
  ['.swift', 'Swift'],
  ['.m', 'Objective-C'],
  ['.mm', 'Objective-C++'],
  ['.cpp', 'C++'],
  ['.cc', 'C++'],
  ['.c', 'C'],
  ['.h', 'C/C++'],
  ['.hpp', 'C++'],
  ['.shader', 'ShaderLab'],
]);

const INTERESTING_FILE_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'tsconfig.base.json',
  'pyproject.toml',
  'requirements.txt',
  'requirements-dev.txt',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'pubspec.yaml',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'ProjectVersion.txt',
  'manifest.json',
  'README',
  'README.md',
  'README.txt',
  'README.rst',
  'AGENTS.md',
  'CLAUDE.md',
  'copilot-instructions.md',
]);

const IMPORTANT_DIRECTORY_NAMES = new Set([
  'app',
  'apps',
  'src',
  'packages',
  'package',
  'backend',
  'frontend',
  'server',
  'service',
  'services',
  'docs',
  'documentation',
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'scripts',
  'bin',
  'cli',
  'lib',
  'core',
  'plugins',
  'mobile',
  'ios',
  'android',
  'desktop',
  'web',
  'Assets',
  'Packages',
  'ProjectSettings',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.parcel-cache',
  '.pnpm-store',
  '.turbo',
  '.venv',
  '.yarn',
  '.idea',
  '.vscode',
  '__pycache__',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  'out',
  'vendor',
  'tmp',
  'temp',
  'DerivedData',
  'Pods',
  'Library',
  'PackageCache',
  'Logs',
  'Temp',
  '.dart_tool',
  '.gradle',
  '.pytest_cache',
  '.mypy_cache',
  'obj',
  'Binaries',
  'Intermediate',
  '.orchestrum',
  'runs',
  'third_party',
]);

const README_FILE_PATTERN = /^README(?:\.[a-z0-9]+)?$/i;
const DOC_FILE_PATTERN = /(?:^|\/)docs?\/.+\.(md|mdx|rst|txt)$/i;
const MARKDOWN_FILE_PATTERN = /\.(md|mdx|rst|txt)$/i;
const CSPROJ_PATTERN = /\.csproj$/i;

const MAX_READ_SIZE_BYTES = 128 * 1024;

const BOUNDARY_SIGNAL_PATTERN = /(read-only|local-first|local only|runtime state|vault|repo-local|global state|artifact|evidence|operator|boundary|contract|constraint|deterministic|snapshot|rewind|plugin|secret|keep\b|preserve\b|limit\b|only\b|must\b|must not|do not|should not|avoid\b|lives under|belongs under|stays under|remain under|instead of|without\b)/i;
const VALIDATION_SIGNAL_PATTERN = /(test|tests|spec|lint|check|validate|validation|verify|doctor|healthcheck|smoke|embed|sync|consult|query|build)/i;
const LEARNING_HEADING_PATTERN = /boundary|boundaries|constraint|constraints|rules|guardrails|troubleshooting|recovery|pitfall|lessons|workflow|operator|safety/i;

const JS_FRAMEWORKS = new Map([
  ['next', 'Next.js'],
  ['react', 'React'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['electron', 'Electron'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['nestjs', 'NestJS'],
  ['@nestjs/core', 'NestJS'],
  ['vite', 'Vite'],
  ['tailwindcss', 'Tailwind CSS'],
  ['vitest', 'Vitest'],
  ['playwright', 'Playwright'],
]);

const PYTHON_FRAMEWORKS = new Map([
  ['django', 'Django'],
  ['flask', 'Flask'],
  ['fastapi', 'FastAPI'],
  ['streamlit', 'Streamlit'],
  ['celery', 'Celery'],
  ['pytest', 'Pytest'],
]);

const GO_FRAMEWORKS = new Map([
  ['gin', 'Gin'],
  ['fiber', 'Fiber'],
  ['cobra', 'Cobra'],
  ['echo', 'Echo'],
]);

const RUST_FRAMEWORKS = new Map([
  ['axum', 'Axum'],
  ['tokio', 'Tokio'],
  ['serde', 'Serde'],
  ['bevy', 'Bevy'],
]);

const DOTNET_FRAMEWORKS = new Map([
  ['Microsoft.AspNetCore.App', 'ASP.NET Core'],
  ['Avalonia', 'Avalonia'],
  ['Microsoft.Maui', '.NET MAUI'],
  ['Serilog', 'Serilog'],
]);

export const DEFAULT_SCAN_OPTIONS = {
  maxDepth: 5,
  maxFiles: 2500,
  maxDirectories: 1200,
  maxInterestingFiles: 80,
  maxReadmeDocuments: 8,
};

export async function analyzeProject(projectRoot, options = {}) {
  const scanOptions = {
    ...DEFAULT_SCAN_OPTIONS,
    ...options,
  };
  const projectName = path.basename(projectRoot);
  const walked = await walkProject(projectRoot, scanOptions);
  const documents = await loadDocuments(projectRoot, walked.interestingFiles, scanOptions.maxReadmeDocuments);
  const packageFacts = await collectPackageFacts(documents);
  const readme = pickPrimaryReadme(documents);
  const purpose = derivePurpose(projectName, readme, packageFacts);
  const languages = deriveLanguages(walked.languageCounts);
  const techStack = deriveTechStack({
    languageCounts: walked.languageCounts,
    packageFacts,
    directories: walked.topDirectories,
    files: walked.files,
  });
  const architecturePatterns = deriveArchitecturePatterns({
    projectName,
    directories: walked.topDirectories,
    packageFacts,
    files: walked.files,
    techStack,
  });
  const problemsSolved = deriveProblemsSolved(readme, purpose, projectName);
  const reusablePatterns = deriveReusablePatterns({
    architecturePatterns,
    packageFacts,
    directories: walked.topDirectories,
    techStack,
    readme,
    documents,
  });
  const boundaryRules = deriveBoundaryRules({
    readme,
    documents,
    architecturePatterns,
  });
  const validationSurfaces = deriveValidationSurfaces({
    readme,
    documents,
    packageFacts,
  });
  const potentialImprovements = derivePotentialImprovements({
    walked,
    readme,
    packageFacts,
    architecturePatterns,
  });
  const documentationSurface = inspectDocumentationSurface({
    readme,
    documents,
  });
  const documentationQualitySignals = deriveDocumentationQualitySignals(documentationSurface);
  const documentationPatterns = deriveDocumentationPatterns(documentationSurface);
  const provenance = buildAnalysisProvenance({
    projectName,
    projectRoot,
    purpose,
    documents,
    readme,
    packageFacts,
    walked,
    techStack,
    architecturePatterns,
    problemsSolved,
    reusablePatterns,
    boundaryRules,
    validationSurfaces,
    documentationQualitySignals,
    documentationPatterns,
    documentationSurface,
  });
  const documentationPaths = uniqueStrings(
    documents
      .filter((document) => document.kind === 'readme' || document.kind === 'doc')
      .map((document) => document.relativePath)
      .slice(0, 12),
  );
  const dependencyNames = uniqueStrings([
    ...packageFacts.javascript.dependencies,
    ...packageFacts.python.dependencies,
    ...packageFacts.go.dependencies,
    ...packageFacts.rust.dependencies,
    ...packageFacts.dotnet.dependencies,
    ...packageFacts.java.dependencies,
    ...packageFacts.dart.dependencies,
  ]).slice(0, 20);
  const entryPoints = detectEntryPoints(walked.files);
  const summary = buildSummary({
    projectName,
    purpose,
    techStack,
    architecturePatterns,
  });
  const warnings = [];

  if (walked.truncated) {
    warnings.push('Scan reached configured limits and used a partial snapshot for indexing.');
  }

  return {
    name: projectName,
    rootPath: projectRoot,
    relativeRoot: projectName,
    evidenceModelVersion: EVIDENCE_MODEL_VERSION,
    fingerprint: createFingerprint({
      files: walked.files,
      directories: walked.topDirectories,
      documents,
      packageFacts,
      truncated: walked.truncated,
    }),
    purpose,
    summary,
    techStack,
    languages,
    architecturePatterns,
    problemsSolved,
    reusablePatterns,
    boundaryRules,
    validationSurfaces,
    documentationQualitySignals,
    documentationPatterns,
    provenance,
    documentationQualityScore: documentationSurface.qualityScore,
    potentialImprovements,
    dependencies: dependencyNames,
    documentationPaths,
    entryPoints,
    topDirectories: walked.topDirectories,
    sourceStats: {
      totalFilesScanned: walked.totalFilesScanned,
      totalDirectoriesScanned: walked.totalDirectoriesScanned,
      codeFilesDetected: walked.codeFilesDetected,
    },
    hasReadme: Boolean(readme),
    hasDocs: documentationPaths.length > 0,
    hasTests: walked.topDirectories.some((directory) => /(?:^|\/)(test|tests|__tests__|spec|specs)(?:\/|$)/i.test(directory)),
    warnings,
    manifestPaths: documents
      .filter((document) => document.kind === 'manifest')
      .map((document) => document.relativePath)
      .slice(0, 20),
    readmeExcerpt: readme?.excerpt ?? '',
    readmeHeadings: readme?.headings ?? [],
  };
}

function createFingerprint(input) {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

async function walkProject(projectRoot, options) {
  const queue = [{ directory: projectRoot, depth: 0 }];
  const files = [];
  const interestingFiles = [];
  const topDirectories = [];
  const languageCounts = new Map();
  let totalFilesScanned = 0;
  let totalDirectoriesScanned = 0;
  let codeFilesDetected = 0;
  let truncated = false;

  scanLoop: while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    let directoryEntries;
    try {
      directoryEntries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    totalDirectoriesScanned += 1;
    if (totalDirectoriesScanned >= options.maxDirectories) {
      truncated = true;
      break;
    }
    const sortedEntries = directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of sortedEntries) {
      const fullPath = path.join(current.directory, entry.name);
      const relativePath = normalizeRelativePath(projectRoot, fullPath);
      if (entry.isDirectory()) {
        if (shouldIgnoreDirectory(entry.name, relativePath)) {
          continue;
        }
        if (current.depth === 0 || IMPORTANT_DIRECTORY_NAMES.has(entry.name)) {
          topDirectories.push(relativePath);
        }
        if (current.depth + 1 <= options.maxDepth) {
          queue.push({ directory: fullPath, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      totalFilesScanned += 1;
      if (totalFilesScanned >= options.maxFiles) {
        truncated = true;
        break scanLoop;
      }

      let stats;
      try {
        stats = await fs.stat(fullPath);
      } catch {
        continue;
      }

      files.push({
        relativePath,
        size: stats.size,
        mtimeMs: Math.round(stats.mtimeMs),
      });

      const extension = path.extname(entry.name).toLowerCase();
      const language = SOURCE_EXTENSIONS.get(extension);
      if (language) {
        codeFilesDetected += 1;
        languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
      }
      if (isInterestingFile(entry.name, relativePath) && interestingFiles.length < options.maxInterestingFiles) {
        interestingFiles.push(relativePath);
      }
    }
  }

  return {
    files,
    interestingFiles,
    topDirectories: uniqueStrings(topDirectories).slice(0, 24),
    languageCounts,
    totalFilesScanned,
    totalDirectoriesScanned,
    codeFilesDetected,
    truncated,
  };
}

function shouldIgnoreDirectory(name, relativePath) {
  if (IGNORED_DIRECTORY_NAMES.has(name)) {
    return true;
  }
  if (name.startsWith('.') && !['.github', '.obsidian'].includes(name)) {
    return true;
  }
  return /(?:^|\/)(node_modules|dist|build|coverage|target|out|Library|PackageCache|DerivedData|Pods|\.venv|__pycache__)(?:\/|$)/.test(relativePath);
}

function isInterestingFile(fileName, relativePath) {
  if (INTERESTING_FILE_NAMES.has(fileName)) {
    return true;
  }
  if (README_FILE_PATTERN.test(fileName)) {
    return true;
  }
  if (DOC_FILE_PATTERN.test(relativePath)) {
    return true;
  }
  if (CSPROJ_PATTERN.test(relativePath)) {
    return true;
  }
  if (/\.slnx?$/.test(relativePath)) {
    return true;
  }
  if (relativePath.endsWith('Packages/manifest.json')) {
    return true;
  }
  return false;
}

async function loadDocuments(projectRoot, interestingFiles, maxReadmeDocuments) {
  const loaded = [];
  let docsLoaded = 0;
  for (const relativePath of interestingFiles) {
    const fileName = path.basename(relativePath);
    const fullPath = path.join(projectRoot, relativePath);
    let text;
    try {
      text = await fs.readFile(fullPath, 'utf8');
    } catch {
      continue;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_READ_SIZE_BYTES) {
      text = text.slice(0, MAX_READ_SIZE_BYTES);
    }
    let kind = 'manifest';
    if (README_FILE_PATTERN.test(fileName)) {
      kind = 'readme';
    } else if (DOC_FILE_PATTERN.test(relativePath) || MARKDOWN_FILE_PATTERN.test(fileName)) {
      kind = 'doc';
    }
    if ((kind === 'readme' || kind === 'doc') && docsLoaded >= maxReadmeDocuments) {
      continue;
    }
    if (kind === 'readme' || kind === 'doc') {
      docsLoaded += 1;
    }
    loaded.push({
      relativePath,
      kind,
      text,
      headings: extractMarkdownHeadings(text),
      excerpt: extractExcerpt(text),
      sections: extractDocumentSections(text),
    });
  }
  return loaded;
}

async function collectPackageFacts(documents) {
  const javascriptDependencies = new Set();
  const javascriptScripts = [];
  const javascriptScriptEntries = [];
  const pythonDependencies = new Set();
  const goDependencies = new Set();
  const rustDependencies = new Set();
  const dotnetDependencies = new Set();
  const javaDependencies = new Set();
  const dartDependencies = new Set();
  const descriptions = [];
  const runtimeSignals = new Set();

  for (const document of documents) {
    const fileName = path.basename(document.relativePath);
    if (fileName === 'package.json') {
      const payload = safeJsonParse(document.text);
      if (payload && typeof payload === 'object') {
        collectObjectKeys(javascriptDependencies, payload.dependencies);
        collectObjectKeys(javascriptDependencies, payload.devDependencies);
        collectObjectKeys(javascriptDependencies, payload.peerDependencies);
        if (typeof payload.description === 'string') {
          descriptions.push(payload.description.trim());
        }
        if (payload.scripts && typeof payload.scripts === 'object') {
          for (const [name, command] of Object.entries(payload.scripts)) {
            if (typeof command === 'string' && command.trim()) {
              javascriptScripts.push(`${name}: ${command.trim()}`);
              javascriptScriptEntries.push({
                name,
                command: command.trim(),
                sourcePath: document.relativePath,
                sourceKind: 'manifest',
                sourceSection: 'scripts',
                excerpt: `${name}: ${command.trim()}`,
              });
            }
          }
        }
        if (payload.packageManager) {
          runtimeSignals.add(String(payload.packageManager));
        }
      }
    } else if (fileName === 'pyproject.toml') {
      for (const dependency of extractTomlArray(document.text, 'dependencies')) {
        pythonDependencies.add(stripVersionSpecifier(dependency));
      }
      for (const dependency of extractPoetryDependencies(document.text)) {
        pythonDependencies.add(stripVersionSpecifier(dependency));
      }
      const description = extractTomlString(document.text, 'description');
      if (description) {
        descriptions.push(description);
      }
    } else if (fileName === 'requirements.txt' || fileName === 'requirements-dev.txt') {
      for (const dependency of extractRequirements(document.text)) {
        pythonDependencies.add(dependency);
      }
    } else if (fileName === 'go.mod') {
      for (const dependency of extractGoDependencies(document.text)) {
        goDependencies.add(dependency);
      }
    } else if (fileName === 'Cargo.toml') {
      for (const dependency of extractCargoDependencies(document.text)) {
        rustDependencies.add(dependency);
      }
      const description = extractCargoDescription(document.text);
      if (description) {
        descriptions.push(description);
      }
    } else if (fileName === 'pom.xml' || fileName === 'build.gradle' || fileName === 'build.gradle.kts') {
      for (const dependency of extractXmlTagValues(document.text, 'artifactId')) {
        javaDependencies.add(dependency);
      }
      for (const dependency of extractGradleDependencies(document.text)) {
        javaDependencies.add(dependency);
      }
    } else if (fileName === 'pubspec.yaml') {
      for (const dependency of extractYamlDependencyKeys(document.text)) {
        dartDependencies.add(dependency);
      }
      const description = extractYamlScalar(document.text, 'description');
      if (description) {
        descriptions.push(description);
      }
    } else if (CSPROJ_PATTERN.test(document.relativePath)) {
      for (const dependency of extractCsprojReferences(document.text)) {
        dotnetDependencies.add(dependency);
      }
    } else if (document.relativePath.endsWith('Packages/manifest.json')) {
      const payload = safeJsonParse(document.text);
      if (payload && typeof payload === 'object' && payload.dependencies) {
        collectObjectKeys(dartDependencies, payload.dependencies);
        runtimeSignals.add('Unity');
      }
    } else if (fileName === 'ProjectVersion.txt') {
      runtimeSignals.add('Unity');
    }
  }

  return {
    descriptions: uniqueStrings(descriptions).filter(Boolean),
    runtimeSignals: uniqueStrings([...runtimeSignals]),
    javascript: {
      dependencies: uniqueStrings([...javascriptDependencies]),
      scripts: uniqueStrings(javascriptScripts),
      scriptEntries: javascriptScriptEntries,
    },
    python: { dependencies: uniqueStrings([...pythonDependencies]) },
    go: { dependencies: uniqueStrings([...goDependencies]) },
    rust: { dependencies: uniqueStrings([...rustDependencies]) },
    dotnet: { dependencies: uniqueStrings([...dotnetDependencies]) },
    java: { dependencies: uniqueStrings([...javaDependencies]) },
    dart: { dependencies: uniqueStrings([...dartDependencies]) },
  };
}

function pickPrimaryReadme(documents) {
  const readmes = documents.filter((document) => document.kind === 'readme');
  if (readmes.length === 0) {
    return null;
  }
  const rootReadme = readmes.find((document) => !document.relativePath.includes('/'));
  return rootReadme ?? readmes[0] ?? null;
}

function derivePurpose(projectName, readme, packageFacts) {
  const readmeExcerpt = cleanInlineMarkdown(readme?.excerpt?.trim() ?? '');
  if (readmeExcerpt) {
    return readmeExcerpt;
  }
  const description = cleanInlineMarkdown(packageFacts.descriptions.find(Boolean) ?? '');
  if (description) {
    return description;
  }
  return `${projectName} is a locally indexed software project tracked inside the AI Brain vault.`;
}

function deriveLanguages(languageCounts) {
  return [...languageCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([language]) => language);
}

function deriveTechStack({ languageCounts, packageFacts, directories, files }) {
  const stack = new Set(deriveLanguages(languageCounts));

  if (packageFacts.javascript.dependencies.length > 0) {
    stack.add('Node.js');
    for (const dependency of packageFacts.javascript.dependencies) {
      const framework = JS_FRAMEWORKS.get(dependency);
      if (framework) {
        stack.add(framework);
      }
    }
  }

  if (packageFacts.python.dependencies.length > 0 || stack.has('Python')) {
    stack.add('Python');
    for (const dependency of packageFacts.python.dependencies) {
      const framework = PYTHON_FRAMEWORKS.get(dependency.toLowerCase());
      if (framework) {
        stack.add(framework);
      }
    }
  }

  if (packageFacts.go.dependencies.length > 0 || stack.has('Go')) {
    stack.add('Go');
    for (const dependency of packageFacts.go.dependencies) {
      const moduleName = dependency.split('/').pop() ?? dependency;
      const framework = GO_FRAMEWORKS.get(moduleName.toLowerCase());
      if (framework) {
        stack.add(framework);
      }
    }
  }

  if (packageFacts.rust.dependencies.length > 0 || stack.has('Rust')) {
    stack.add('Rust');
    for (const dependency of packageFacts.rust.dependencies) {
      const framework = RUST_FRAMEWORKS.get(dependency.toLowerCase());
      if (framework) {
        stack.add(framework);
      }
    }
  }

  if (packageFacts.dotnet.dependencies.length > 0 || stack.has('.NET')) {
    stack.add('.NET');
    for (const dependency of packageFacts.dotnet.dependencies) {
      const framework = DOTNET_FRAMEWORKS.get(dependency);
      if (framework) {
        stack.add(framework);
      }
    }
  }

  if (packageFacts.java.dependencies.length > 0 || stack.has('Java') || stack.has('Kotlin')) {
    stack.add('Java');
    if (packageFacts.java.dependencies.some((dependency) => /spring/i.test(dependency))) {
      stack.add('Spring');
    }
    if (packageFacts.java.dependencies.some((dependency) => /junit/i.test(dependency))) {
      stack.add('JUnit');
    }
  }

  if (packageFacts.dart.dependencies.length > 0 || stack.has('Dart')) {
    stack.add('Dart');
    if (files.some((file) => file.relativePath === 'pubspec.yaml')) {
      stack.add('Flutter');
    }
  }

  if (packageFacts.runtimeSignals.includes('Unity') || directories.some((directory) => /(?:^|\/)(Assets|ProjectSettings|Packages)(?:\/|$)/.test(directory))) {
    stack.add('Unity');
  }

  if (files.some((file) => file.relativePath === 'Dockerfile' || /docker-compose\.(yml|yaml)$/.test(file.relativePath))) {
    stack.add('Docker');
  }

  if (directories.some((directory) => /(?:^|\/)(ios|android|mobile)(?:\/|$)/i.test(directory))) {
    stack.add('Mobile');
  }

  return uniqueStrings([...stack]).slice(0, 12);
}

function deriveArchitecturePatterns({ projectName, directories, packageFacts, files, techStack }) {
  const patterns = new Set();
  const directorySet = new Set(directories.map((directory) => directory.split('/')[0]));

  if (directorySet.has('apps') && (directorySet.has('packages') || directorySet.has('libs'))) {
    patterns.add('Monorepo with separate app and package boundaries');
  }
  if (directorySet.has('frontend') && directorySet.has('backend')) {
    patterns.add('Explicit frontend and backend split');
  }
  if (directorySet.has('apps') && directorySet.has('docs')) {
    patterns.add('Product surfaces documented alongside implementation code');
  }
  if (directorySet.has('plugins')) {
    patterns.add('Plugin or extension surface for local customization');
  }
  if (directorySet.has('scripts') || directorySet.has('cli') || directorySet.has('bin')) {
    patterns.add('Automation-first workflow with scriptable entrypoints');
  }
  if (directories.some((directory) => /(?:^|\/)(tests|test|__tests__|spec|specs)(?:\/|$)/.test(directory))) {
    patterns.add('Repository includes dedicated verification or test surfaces');
  }
  if (techStack.includes('Electron')) {
    patterns.add('Desktop shell layered on top of shared application runtime');
  }
  if (techStack.includes('Next.js') || techStack.includes('React')) {
    patterns.add('Component-driven frontend architecture');
  }
  if (techStack.includes('Unity')) {
    patterns.add('Unity game project structure with assets and editor configuration');
  }
  if (techStack.includes('Flutter')) {
    patterns.add('Cross-platform client project with shared Dart code');
  }
  if (packageFacts.javascript.dependencies.some((dependency) => dependency === 'vitest' || dependency === 'playwright')) {
    patterns.add('Local developer workflow backed by automated validation tools');
  }
  if (files.some((file) => /^docs\//.test(file.relativePath))) {
    patterns.add('Docs-as-code knowledge capture inside the repository');
  }

  if (patterns.size === 0) {
    patterns.add(`${projectName} uses a focused repository layout around ${techStack[0] ?? 'its primary codebase'} assets.`);
  }

  return uniqueStrings([...patterns]).slice(0, 8);
}

function deriveProblemsSolved(readme, purpose, projectName) {
  const repoSignals = [readme].filter(Boolean);
  const candidates = uniqueStrings([
    ...repoSignals.flatMap((document) => extractBulletStatements(document?.text ?? '')),
    ...repoSignals.flatMap((document) => extractDescriptiveSentences(document?.text ?? '')),
  ])
    .map((candidate) => normalizeProblemCandidate(candidate))
    .filter((candidate) => isUsefulProblemCandidate(candidate, projectName) && isHighSignalProblemCandidate(candidate));
  if (candidates.length > 0) {
    return candidates.slice(0, 4);
  }
  const headings = (readme?.headings ?? [])
    .filter((heading) => !/^readme$/i.test(heading))
    .filter((heading) => LEARNING_HEADING_PATTERN.test(heading))
    .slice(0, 3);
  if (headings.length > 0) {
    return headings.map((heading) => `${projectName} addresses the concern described under “${heading}”.`);
  }
  return [];
}

function deriveReusablePatterns({ architecturePatterns, packageFacts, directories, techStack, readme, documents }) {
  const patterns = new Set();
  for (const architecturePattern of architecturePatterns) {
    if (/monorepo/i.test(architecturePattern)) {
      patterns.add('Use modular folders and shared packages to separate reusable capabilities from product surfaces.');
    }
    if (/frontend and backend split/i.test(architecturePattern)) {
      patterns.add('Keep UI and service concerns isolated so each surface can evolve independently.');
    }
    if (/plugin/i.test(architecturePattern)) {
      patterns.add('Expose a controlled extension surface for local project-specific automation.');
    }
    if (/scriptable entrypoints/i.test(architecturePattern)) {
      patterns.add('Encode repeated workflows as local scripts so agents can replay them deterministically.');
    }
    if (/docs-as-code/i.test(architecturePattern)) {
      patterns.add('Store architecture and operating knowledge next to implementation to keep drift visible.');
    }
  }
  if (techStack.includes('Unity')) {
    patterns.add('Separate gameplay assets, packages, and editor settings so game state changes stay inspectable.');
  }
  if (techStack.includes('Flutter')) {
    patterns.add('Share client logic in Dart while isolating platform-specific shells under iOS and Android folders.');
  }
  if (packageFacts.javascript.dependencies.length > 0 && directories.some((directory) => directory.startsWith('packages/'))) {
    patterns.add('Use package-level ownership to capture reusable services, UI primitives, or automation helpers.');
  }

  for (const candidate of uniqueStrings([
    ...extractBulletStatements(readme?.text ?? ''),
    ...documents.flatMap((document) => extractBulletStatements(document.text ?? '')),
  ])) {
    const normalized = normalizeProblemCandidate(candidate);
    if (isHighSignalPatternCandidate(normalized)) {
      patterns.add(ensureTrailingPeriod(normalized));
    }
  }

  return uniqueStrings([...patterns]).slice(0, 8);
}

function deriveBoundaryRules({ readme, documents, architecturePatterns }) {
  const candidates = uniqueStrings([
    ...extractBulletStatements(readme?.text ?? ''),
    ...extractDescriptiveSentences(readme?.text ?? ''),
    ...documents.flatMap((document) => extractBulletStatements(document.text ?? '')),
    ...documents.flatMap((document) => extractDescriptiveSentences(document.text ?? '')),
  ])
    .map((candidate) => normalizeProblemCandidate(candidate))
    .filter((candidate) => isHighSignalBoundaryCandidate(candidate));

  if (candidates.length > 0) {
    return candidates.slice(0, 8).map((candidate) => ensureTrailingPeriod(candidate));
  }

  const inferred = [];
  if (architecturePatterns.some((pattern) => /docs-as-code/i.test(pattern))) {
    inferred.push('Treat docs as part of the operating surface, not as optional afterthoughts.');
  }
  if (architecturePatterns.some((pattern) => /automation-first/i.test(pattern))) {
    inferred.push('Keep repeated operator workflows explicit and scriptable instead of relying on ad hoc local steps.');
  }
  return inferred.slice(0, 4);
}

function deriveValidationSurfaces({ readme, documents, packageFacts }) {
  const commands = uniqueStrings([
    ...extractShellCommands(readme?.text ?? ''),
    ...documents.flatMap((document) => extractShellCommands(document.text ?? '')),
    ...(packageFacts.javascript.scripts ?? [])
      .filter((entry) => VALIDATION_SIGNAL_PATTERN.test(entry))
      .map((entry) => `Package script: ${entry}`),
  ])
    .map((entry) => normalizeProblemCandidate(entry))
    .filter((entry) => isUsefulValidationSurface(entry));

  return commands.slice(0, 8);
}

function derivePotentialImprovements({ walked, readme, packageFacts, architecturePatterns }) {
  const improvements = new Set();
  if (!readme) {
    improvements.add('Add a top-level README so future indexing runs can identify the project purpose more accurately.');
  }
  if (!walked.topDirectories.some((directory) => /(?:^|\/)(tests|test|__tests__|spec|specs)(?:\/|$)/.test(directory))) {
    improvements.add('Document or add automated verification paths so agents can evaluate changes with less ambiguity.');
  }
  if (!walked.topDirectories.some((directory) => directory === 'docs' || directory.startsWith('docs/'))) {
    improvements.add('Capture architectural decisions in a dedicated docs area to improve long-term discoverability.');
  }
  if (walked.truncated) {
    improvements.add('Add a project-specific deep-scan profile if this repository needs more granular indexing than the default limits allow.');
  }
  if (architecturePatterns.some((pattern) => /monorepo/i.test(pattern)) && !packageFacts.javascript.dependencies.includes('turbo') && !packageFacts.javascript.dependencies.includes('nx')) {
    improvements.add('If module count grows further, document build ownership and task orchestration between packages.');
  }
  if (improvements.size === 0) {
    improvements.add('Continue adding high-signal operational notes so future agents can reuse this project context quickly.');
  }
  return uniqueStrings([...improvements]).slice(0, 6);
}

function inspectDocumentationSurface({ readme, documents }) {
  const readmeText = String(readme?.text ?? '');
  const readmeHeadings = readme?.headings ?? [];
  const architectureDoc = documents.find((document) => /(?:^|\/)ARCHITECTURE\.md$/i.test(document.relativePath)) ?? null;
  const troubleshootingDoc = documents.find((document) => /(?:^|\/)TROUBLESHOOTING\.md$/i.test(document.relativePath)) ?? null;
  const docsIndex = documents.find((document) => /(?:^|\/)docs\/README\.md$/i.test(document.relativePath)) ?? null;
  const cliDoc = documents.find((document) => /(?:^|\/)docs\/CLI\.md$/i.test(document.relativePath)) ?? null;
  const agentGuidanceDocs = documents.filter((document) => /(?:^|\/)(AGENTS|CLAUDE)\.md$/i.test(document.relativePath) || /(?:^|\/)\.github\/copilot-instructions\.md$/i.test(document.relativePath));
  const centeredHero = /<div\s+align=["']center["']|<p\s+align=["']center["']/i.test(readmeText);
  const badgeRow = /img\.shields\.io/i.test(readmeText);
  const anchorNav = /<a\s+href="#.+?">/i.test(readmeText) || /\[[^\]]+\]\(#.+?\)/i.test(readmeText);
  const showcasePanels = /<table[\s>]/i.test(readmeText) && /<img[\s>]/i.test(readmeText);
  const detailsBlocks = /<details>/i.test(readmeText);
  const mermaidInReadme = /```mermaid/i.test(readmeText);
  const mermaidInDocs = documents.some((document) => /```mermaid/i.test(document.text ?? ''));
  const architectureRhythm = Boolean(architectureDoc && /##\s+Overview/i.test(architectureDoc.text) && /##\s+Data Flow/i.test(architectureDoc.text));
  const troubleshootingRhythm = Boolean(troubleshootingDoc && /Symptoms:/i.test(troubleshootingDoc.text) && /Checks:/i.test(troubleshootingDoc.text));
  const gettingStarted = readmeHeadings.some((heading) => /Getting Started/i.test(heading));
  const appendixRhythm = readmeHeadings.some((heading) => /Appendix/i.test(heading));
  const productSurface = readmeHeadings.some((heading) => /Product Surface|Showcase|Features/i.test(heading));
  const docsSplit = [architectureDoc, troubleshootingDoc, docsIndex, cliDoc].filter(Boolean).length >= 2;

  let qualityScore = 0;
  qualityScore += centeredHero ? 1 : 0;
  qualityScore += badgeRow ? 1 : 0;
  qualityScore += anchorNav ? 1 : 0;
  qualityScore += showcasePanels ? 1 : 0;
  qualityScore += (mermaidInReadme || mermaidInDocs) ? 1 : 0;
  qualityScore += docsSplit ? 1 : 0;
  qualityScore += architectureRhythm ? 1 : 0;
  qualityScore += troubleshootingRhythm ? 1 : 0;
  qualityScore += detailsBlocks ? 1 : 0;
  qualityScore += agentGuidanceDocs.length > 0 ? 1 : 0;

  return {
    readmePath: readme?.relativePath ?? null,
    architectureDocPath: architectureDoc?.relativePath ?? null,
    troubleshootingDocPath: troubleshootingDoc?.relativePath ?? null,
    docsIndexPath: docsIndex?.relativePath ?? null,
    cliDocPath: cliDoc?.relativePath ?? null,
    agentGuidancePaths: agentGuidanceDocs.map((document) => document.relativePath),
    centeredHero,
    badgeRow,
    anchorNav,
    showcasePanels,
    detailsBlocks,
    mermaidInReadme,
    mermaidInDocs,
    docsSplit,
    architectureRhythm,
    troubleshootingRhythm,
    gettingStarted,
    appendixRhythm,
    productSurface,
    qualityScore,
  };
}

function deriveDocumentationQualitySignals(surface) {
  const signals = [];
  if (surface.centeredHero && surface.badgeRow) {
    signals.push('README behaves like a cover surface with a centered hero and badge-led framing.');
  }
  if (surface.anchorNav) {
    signals.push('README exposes anchor navigation so the landing page stays fast to scan on GitHub.');
  }
  if (surface.showcasePanels) {
    signals.push('README previews the product surface with panel-like or card-like sections instead of dropping straight into raw reference text.');
  }
  if (surface.mermaidInReadme || surface.mermaidInDocs) {
    signals.push('Documentation uses Mermaid where topology or flow actually benefits from a diagram.');
  }
  if (surface.docsSplit) {
    signals.push('Architecture, troubleshooting, or CLI guidance is split into focused docs instead of overloading the README.');
  }
  if (surface.architectureRhythm) {
    signals.push('Architecture docs lead with overview and data flow before subsystem detail.');
  }
  if (surface.troubleshootingRhythm) {
    signals.push('Troubleshooting guidance uses symptom and check blocks for quick operator scanning.');
  }
  if (surface.agentGuidancePaths.length > 0) {
    signals.push('The repository includes explicit agent-facing guidance alongside public documentation.');
  }
  return uniqueStrings(signals).slice(0, 8);
}

function deriveDocumentationPatterns(surface) {
  const patterns = new Set();
  if (surface.centeredHero && surface.badgeRow && surface.anchorNav) {
    patterns.add('README opening sequence pattern: centered hero, concise product framing, badge row, and anchor navigation before deeper detail.');
  }
  if (surface.showcasePanels) {
    patterns.add('GitHub showcase pattern: preview the product surface with panel-like sections before architecture and operator detail.');
  }
  if (surface.mermaidInReadme || surface.mermaidInDocs) {
    patterns.add('Diagram placement pattern: use Mermaid at system topology and workflow transitions, then return to short prose.');
  }
  if (surface.docsSplit) {
    patterns.add('Documentation layout pattern: keep the README as the public cover, then split architecture, operator, CLI, or troubleshooting guidance into focused docs.');
  }
  if (surface.architectureRhythm) {
    patterns.add('Architecture document pattern: sequence overview, data flow, package boundaries, and storage model before runtime-specific detail.');
  }
  if (surface.troubleshootingRhythm) {
    patterns.add('Troubleshooting pattern: organize issues by symptoms, checks, and recovery steps so operators can scan directly to action.');
  }
  if (surface.agentGuidancePaths.length > 0) {
    patterns.add('Agent guidance pattern: keep repo instructions boundary-led, authoritative-file-driven, and explicit about forbidden regressions.');
  }
  if (surface.productSurface && surface.gettingStarted && surface.appendixRhythm) {
    patterns.add('README pacing pattern: product story first, system explanation second, getting started third, appendix or reference last.');
  }
  if (surface.detailsBlocks) {
    patterns.add('Progressive disclosure pattern: hide secondary commands or file layouts behind details blocks so the main README stays tight.');
  }
  return uniqueStrings([...patterns]).slice(0, 8);
}

function buildAnalysisProvenance({
  projectName,
  projectRoot,
  purpose,
  documents,
  readme,
  packageFacts,
  walked,
  techStack,
  architecturePatterns,
  problemsSolved,
  reusablePatterns,
  boundaryRules,
  validationSurfaces,
  documentationQualitySignals,
  documentationPatterns,
  documentationSurface,
}) {
  const architecture = buildArchitectureProvenance({
    projectRoot,
    documents,
    packageFacts,
    directories: walked.topDirectories,
    files: walked.files,
    techStack,
    architecturePatterns,
  });

  return {
    purpose: buildPurposeProvenance({
      purpose,
      projectRoot,
      documents,
      readme,
      packageFacts,
    }),
    architecture,
    recurringProblems: buildDocumentMatchedEvidence({
      category: 'recurringProblems',
      values: problemsSolved,
      documents: readme ? [readme] : documents.filter((document) => document.kind === 'readme' || document.kind === 'doc'),
      fallbackDerivedFrom: 'heuristic-inference',
    }),
    reusableSolutions: buildReusablePatternProvenance({
      reusablePatterns,
      architecture,
      documents,
      directories: walked.topDirectories,
      files: walked.files,
      packageFacts,
    }),
    boundaryRules: buildBoundaryRuleProvenance({
      boundaryRules,
      documents,
      architecture,
    }),
    validationSurfaces: buildValidationSurfaceProvenance({
      validationSurfaces,
      documents,
      packageFacts,
    }),
    documentationQualitySignals: buildDocumentationQualitySignalProvenance({
      documentationQualitySignals,
      documentationSurface,
    }),
    documentationPatterns: buildDocumentationPatternProvenance({
      documentationPatterns,
      documentationSurface,
    }),
  };
}

function buildPurposeProvenance({ purpose, projectRoot, documents, readme, packageFacts }) {
  const normalizedPurpose = normalizeProblemCandidate(purpose);
  const readmeSource = readme?.excerpt
    ? createEvidenceSource({
      sourcePath: readme.relativePath,
      sourceKind: readme.kind,
      sourceSection: readme.sections?.[0]?.heading ?? 'opening',
      excerpt: readme.excerpt,
    })
    : null;
  const description = packageFacts.descriptions.find(Boolean) ?? '';
  const descriptionDocument = description
    ? documents.find((document) => document.text.includes(description))
    : null;
  const descriptionSource = descriptionDocument
    ? createEvidenceSource({
      sourcePath: descriptionDocument.relativePath,
      sourceKind: descriptionDocument.kind,
      sourceSection: 'description',
      excerpt: description,
    })
    : null;

  return createEvidenceItem({
    category: 'purpose',
    value: normalizedPurpose,
    sources: [readmeSource, descriptionSource].filter(Boolean),
    derivedFrom: readmeSource
      ? 'readme-excerpt'
      : (descriptionSource ? 'package-manifest' : 'heuristic-fallback'),
    confidence: readmeSource || descriptionSource ? undefined : 0.34,
    evidenceQuality: readmeSource || descriptionSource ? undefined : 'weak',
  }) ?? createEvidenceItem({
    category: 'purpose',
    value: `${path.basename(projectRoot)} purpose could not be supported by README or manifest evidence.`,
    sources: [],
    derivedFrom: 'heuristic-fallback',
    confidence: 0.34,
    evidenceQuality: 'weak',
  });
}

function buildArchitectureProvenance({ projectRoot, documents, packageFacts, directories, files, techStack, architecturePatterns }) {
  const items = [];
  const packageJsonSource = findDocumentByName(documents, 'package.json');
  const docsSource = findDirectorySource(directories, /^docs(?:\/|$)/i, 'Detected docs/ as a first-class repository surface.');

  for (const pattern of architecturePatterns) {
    if (/Monorepo with separate app and package boundaries/i.test(pattern)) {
      items.push(createEvidenceItem({
        category: 'architecture',
        value: pattern,
        derivedFrom: 'directory-layout',
        sources: [
          findDirectorySource(directories, /^apps(?:\/|$)/i, 'Detected apps/ top-level boundary.'),
          findDirectorySource(directories, /^(packages|libs)(?:\/|$)/i, 'Detected packages/ or libs/ top-level boundary.'),
        ].filter(Boolean),
      }));
      continue;
    }
    if (/Explicit frontend and backend split/i.test(pattern)) {
      items.push(createEvidenceItem({
        category: 'architecture',
        value: pattern,
        derivedFrom: 'directory-layout',
        sources: [
          findDirectorySource(directories, /^frontend(?:\/|$)/i, 'Detected frontend/ top-level boundary.'),
          findDirectorySource(directories, /^backend(?:\/|$)/i, 'Detected backend/ top-level boundary.'),
        ].filter(Boolean),
      }));
      continue;
    }
    if (/Product surfaces documented alongside implementation code/i.test(pattern)) {
      items.push(createEvidenceItem({
        category: 'architecture',
        value: pattern,
        derivedFrom: 'directory-layout',
        sources: [
          findDirectorySource(directories, /^apps(?:\/|$)/i, 'Detected apps/ product surface.'),
          docsSource,
        ].filter(Boolean),
      }));
      continue;
    }
    if (/Plugin or extension surface/i.test(pattern)) {
      items.push(createEvidenceItem({
        category: 'architecture',
        value: pattern,
        derivedFrom: 'directory-layout',
        sources: [findDirectorySource(directories, /^plugins(?:\/|$)/i, 'Detected plugins/ extension surface.')].filter(Boolean),
      }));
      continue;
    }
    if (/Automation-first workflow with scriptable entrypoints/i.test(pattern)) {
      items.push(createEvidenceItem({
        category: 'architecture',
        value: pattern,
        derivedFrom: 'directory-layout',
        sources: [
          findDirectorySource(directories, /^scripts(?:\/|$)/i, 'Detected scripts/ operator surface.'),
          findDirectorySource(directories, /^cli(?:\/|$)/i, 'Detected cli/ entry surface.'),
          packageJsonSource
            ? createEvidenceSource({
              sourcePath: packageJsonSource.relativePath,
              sourceKind: packageJsonSource.kind,
              sourceSection: 'scripts',
              excerpt: 'package.json exposes runnable operator scripts.',
            })
            : null,
        ].filter(Boolean),
      }));
      continue;
    }
    if (/verification or test surfaces/i.test(pattern)) {
      items.push(createEvidenceItem({
        category: 'architecture',
        value: pattern,
        derivedFrom: 'directory-layout',
        sources: [
          findDirectorySource(directories, /(?:^|\/)(tests|test|__tests__|spec|specs)(?:\/|$)/i, 'Detected tests/ or specs/ verification surface.'),
          packageJsonSource
            ? createEvidenceSource({
              sourcePath: packageJsonSource.relativePath,
              sourceKind: packageJsonSource.kind,
              sourceSection: 'scripts',
              excerpt: 'package.json includes test-like scripts or validation tasks.',
            })
            : null,
        ].filter(Boolean),
      }));
      continue;
    }
    if (/Docs-as-code knowledge capture inside the repository/i.test(pattern)) {
      items.push(createEvidenceItem({
        category: 'architecture',
        value: pattern,
        derivedFrom: 'doc-structure',
        sources: [
          docsSource,
          ...documents
            .filter((document) => document.kind === 'doc')
            .slice(0, 2)
            .map((document) => createEvidenceSource({
              sourcePath: document.relativePath,
              sourceKind: document.kind,
              sourceSection: document.sections?.[0]?.heading ?? 'opening',
              excerpt: document.excerpt,
            })),
        ].filter(Boolean),
      }));
      continue;
    }
    if (/Component-driven frontend architecture/i.test(pattern) && packageJsonSource) {
      items.push(createEvidenceItem({
        category: 'architecture',
        value: pattern,
        derivedFrom: 'package-manifest',
        sources: [createEvidenceSource({
          sourcePath: packageJsonSource.relativePath,
          sourceKind: packageJsonSource.kind,
          sourceSection: 'dependencies',
          excerpt: `Detected frontend stack signals in package.json: ${techStack.filter((item) => /React|Next\.js|Vue|Svelte/i.test(item)).join(', ')}`,
        })],
      }));
      continue;
    }
    if (/Desktop shell layered on top of shared application runtime/i.test(pattern) && packageJsonSource) {
      items.push(createEvidenceItem({
        category: 'architecture',
        value: pattern,
        derivedFrom: 'package-manifest',
        sources: [createEvidenceSource({
          sourcePath: packageJsonSource.relativePath,
          sourceKind: packageJsonSource.kind,
          sourceSection: 'dependencies',
          excerpt: 'Detected Electron dependency in package.json.',
        })],
      }));
      continue;
    }
    if (/Unity game project structure/i.test(pattern)) {
      items.push(createEvidenceItem({
        category: 'architecture',
        value: pattern,
        derivedFrom: 'directory-layout',
        sources: [
          findDirectorySource(directories, /^Assets(?:\/|$)/, 'Detected Unity Assets/ directory.'),
          findDirectorySource(directories, /^ProjectSettings(?:\/|$)/, 'Detected Unity ProjectSettings/ directory.'),
          findFileSource(files, 'ProjectVersion.txt', 'Detected Unity ProjectVersion.txt runtime marker.'),
        ].filter(Boolean),
      }));
      continue;
    }
    if (/Cross-platform client project with shared Dart code/i.test(pattern)) {
      items.push(createEvidenceItem({
        category: 'architecture',
        value: pattern,
        derivedFrom: 'package-manifest',
        sources: [
          findFileSource(files, 'pubspec.yaml', 'Detected Flutter/Dart entry manifest.'),
          findDirectorySource(directories, /^ios(?:\/|$)/i, 'Detected iOS platform shell.'),
          findDirectorySource(directories, /^android(?:\/|$)/i, 'Detected Android platform shell.'),
        ].filter(Boolean),
      }));
      continue;
    }
    if (/Local developer workflow backed by automated validation tools/i.test(pattern) && packageJsonSource) {
      items.push(createEvidenceItem({
        category: 'architecture',
        value: pattern,
        derivedFrom: 'package-manifest',
        sources: [createEvidenceSource({
          sourcePath: packageJsonSource.relativePath,
          sourceKind: packageJsonSource.kind,
          sourceSection: 'dependencies',
          excerpt: 'Detected test-tool dependencies such as vitest or playwright in package.json.',
        })],
      }));
      continue;
    }

    items.push(createEvidenceItem({
      category: 'architecture',
      value: pattern,
      derivedFrom: 'heuristic-inference',
      sources: [createEvidenceSource({
        sourcePath: path.basename(projectRoot),
        sourceKind: 'directory',
        sourceSection: 'scan',
        excerpt: `Inferred from repository layout and stack: ${pattern}`,
      })],
    }));
  }

  return mergeEvidenceItems(items).slice(0, 8);
}

function buildReusablePatternProvenance({ reusablePatterns, architecture, documents, directories, files, packageFacts }) {
  const architectureByValue = new Map((architecture ?? []).map((item) => [item.value, item]));
  const items = [];

  for (const pattern of reusablePatterns) {
    let derivedFrom = 'explicit-doc';
    let sources = findBestEvidenceSourcesForValue(pattern, documents);

    if (/Use modular folders and shared packages/i.test(pattern)) {
      sources = architectureByValue.get('Monorepo with separate app and package boundaries')?.sources ?? sources;
      derivedFrom = 'directory-layout';
    } else if (/Keep UI and service concerns isolated/i.test(pattern)) {
      sources = architectureByValue.get('Explicit frontend and backend split')?.sources ?? sources;
      derivedFrom = 'directory-layout';
    } else if (/Expose a controlled extension surface/i.test(pattern)) {
      sources = architectureByValue.get('Plugin or extension surface for local customization')?.sources ?? sources;
      derivedFrom = 'directory-layout';
    } else if (/Encode repeated workflows as local scripts/i.test(pattern)) {
      sources = architectureByValue.get('Automation-first workflow with scriptable entrypoints')?.sources ?? sources;
      derivedFrom = 'directory-layout';
    } else if (/Store architecture and operating knowledge next to implementation/i.test(pattern)) {
      sources = architectureByValue.get('Docs-as-code knowledge capture inside the repository')?.sources ?? sources;
      derivedFrom = 'doc-structure';
    } else if (/Separate gameplay assets, packages, and editor settings/i.test(pattern)) {
      sources = [
        findDirectorySource(directories, /^Assets(?:\/|$)/, 'Detected Unity Assets/ game content boundary.'),
        findDirectorySource(directories, /^ProjectSettings(?:\/|$)/, 'Detected Unity ProjectSettings/ editor configuration boundary.'),
      ].filter(Boolean);
      derivedFrom = 'directory-layout';
    } else if (/Share client logic in Dart/i.test(pattern)) {
      sources = [
        findFileSource(files, 'pubspec.yaml', 'Flutter manifest anchors shared client logic.'),
        findDirectorySource(directories, /^ios(?:\/|$)/i, 'Detected iOS shell.'),
        findDirectorySource(directories, /^android(?:\/|$)/i, 'Detected Android shell.'),
      ].filter(Boolean);
      derivedFrom = 'package-manifest';
    } else if (/Use package-level ownership/i.test(pattern)) {
      sources = [findDirectorySource(directories, /^packages(?:\/|$)/i, 'Detected packages/ reusable ownership boundary.')].filter(Boolean);
      derivedFrom = 'directory-layout';
    } else if (sources.length === 0 && packageFacts.javascript.scriptEntries.length > 0 && /script|workflow|operator|validate/i.test(pattern)) {
      sources = packageFacts.javascript.scriptEntries.slice(0, 2).map((entry) => createEvidenceSource(entry));
      derivedFrom = 'manifest-script';
    }

    items.push(createEvidenceItem({
      category: 'reusableSolutions',
      value: pattern,
      sources,
      derivedFrom: sources.length > 0 ? derivedFrom : 'heuristic-inference',
      confidence: sources.length > 0 ? undefined : 0.52,
      evidenceQuality: sources.length > 0 ? undefined : 'weak',
    }));
  }

  return mergeEvidenceItems(items).slice(0, 8);
}

function buildBoundaryRuleProvenance({ boundaryRules, documents, architecture }) {
  const architectureByValue = new Map((architecture ?? []).map((item) => [item.value, item]));
  const items = [];

  for (const rule of boundaryRules) {
    let sources = findBestEvidenceSourcesForValue(rule, documents.filter((document) => document.kind === 'readme' || document.kind === 'doc' || /AGENTS|CLAUDE|copilot-instructions/i.test(document.relativePath)));
    let derivedFrom = sources.length > 0 ? 'explicit-doc' : 'heuristic-inference';

    if (sources.length === 0 && /Treat docs as part of the operating surface/i.test(rule)) {
      sources = architectureByValue.get('Docs-as-code knowledge capture inside the repository')?.sources ?? [];
      derivedFrom = 'doc-structure';
    }
    if (sources.length === 0 && /Keep repeated operator workflows explicit and scriptable/i.test(rule)) {
      sources = architectureByValue.get('Automation-first workflow with scriptable entrypoints')?.sources ?? [];
      derivedFrom = 'directory-layout';
    }

    items.push(createEvidenceItem({
      category: 'boundaryRules',
      value: rule,
      sources,
      derivedFrom,
      confidence: sources.length > 0 ? undefined : 0.48,
      evidenceQuality: sources.length > 0 ? undefined : 'weak',
    }));
  }

  return mergeEvidenceItems(items).slice(0, 8);
}

function buildValidationSurfaceProvenance({ validationSurfaces, documents, packageFacts }) {
  const items = [];
  for (const surface of validationSurfaces) {
    const scriptEntry = packageFacts.javascript.scriptEntries.find((entry) => surface.includes(`${entry.name}: ${entry.command}`));
    const sources = scriptEntry
      ? [createEvidenceSource(scriptEntry)]
      : findBestEvidenceSourcesForValue(surface, documents, { candidateKinds: ['command'] });
    items.push(createEvidenceItem({
      category: 'validationSurfaces',
      value: surface,
      sources,
      derivedFrom: scriptEntry ? 'manifest-script' : (sources.length > 0 ? 'explicit-doc' : 'heuristic-inference'),
      confidence: sources.length > 0 ? undefined : 0.5,
      evidenceQuality: sources.length > 0 ? undefined : 'weak',
    }));
  }
  return mergeEvidenceItems(items).slice(0, 8);
}

function buildDocumentationQualitySignalProvenance({ documentationQualitySignals, documentationSurface }) {
  const items = [];
  for (const signal of documentationQualitySignals) {
    items.push(createEvidenceItem({
      category: 'documentationQualitySignals',
      value: signal,
      sources: resolveDocumentationSourcesForSignal(signal, documentationSurface),
      derivedFrom: 'doc-structure',
    }));
  }
  return mergeEvidenceItems(items).slice(0, 8);
}

function buildDocumentationPatternProvenance({ documentationPatterns, documentationSurface }) {
  const items = [];
  for (const pattern of documentationPatterns) {
    items.push(createEvidenceItem({
      category: 'documentationPatterns',
      value: pattern,
      sources: resolveDocumentationSourcesForPattern(pattern, documentationSurface),
      derivedFrom: 'doc-structure',
    }));
  }
  return mergeEvidenceItems(items).slice(0, 8);
}

function buildDocumentMatchedEvidence({ category, values, documents, fallbackDerivedFrom = 'heuristic-inference' }) {
  return mergeEvidenceItems(values.map((value) => {
    const sources = findBestEvidenceSourcesForValue(value, documents);
    return createEvidenceItem({
      category,
      value,
      sources,
      derivedFrom: sources.length > 0 ? 'explicit-doc' : fallbackDerivedFrom,
      confidence: sources.length > 0 ? undefined : 0.46,
      evidenceQuality: sources.length > 0 ? undefined : 'weak',
    });
  })).slice(0, 8);
}

function findBestEvidenceSourcesForValue(value, documents, { candidateKinds = ['bullet', 'sentence', 'heading', 'command'], maxSources = 2, minScore = 0.28 } = {}) {
  const candidates = collectEvidenceCandidates(documents, { candidateKinds });
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreEvidenceCandidate(value, candidate.value),
    }))
    .filter((entry) => entry.score >= minScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxSources)
    .map((entry) => createEvidenceSource(entry.candidate));

  return scored;
}

function collectEvidenceCandidates(documents, { candidateKinds = ['bullet', 'sentence', 'heading', 'command'] } = {}) {
  const candidates = [];
  for (const document of documents.filter(Boolean)) {
    if (candidateKinds.includes('heading')) {
      for (const section of document.sections ?? []) {
        if (!section.heading) {
          continue;
        }
        candidates.push({
          sourcePath: document.relativePath,
          sourceKind: document.kind,
          sourceSection: section.heading,
          excerpt: section.heading,
          value: normalizeProblemCandidate(section.heading),
        });
      }
    }

    for (const section of document.sections ?? []) {
      if (candidateKinds.includes('bullet')) {
        for (const rawLine of String(section.text ?? '').split('\n')) {
          if (!/^[-*]\s+/.test(rawLine.trim()) && !/^\d+\.\s+/.test(rawLine.trim())) {
            continue;
          }
          const value = normalizeProblemCandidate(rawLine.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim());
          if (!value) {
            continue;
          }
          candidates.push({
            sourcePath: document.relativePath,
            sourceKind: document.kind,
            sourceSection: section.heading,
            excerpt: value,
            value,
          });
        }
      }

      if (candidateKinds.includes('sentence')) {
        for (const sentence of markdownToText(section.text ?? '')
          .replace(/\n+/g, ' ')
          .split(/[.!?]\s+/)
          .map((entry) => normalizeProblemCandidate(entry))) {
          if (!sentence || sentence.length < 24) {
            continue;
          }
          candidates.push({
            sourcePath: document.relativePath,
            sourceKind: document.kind,
            sourceSection: section.heading,
            excerpt: sentence,
            value: sentence,
          });
        }
      }

      if (candidateKinds.includes('command')) {
        for (const command of extractShellCommands(section.text ?? '')) {
          candidates.push({
            sourcePath: document.relativePath,
            sourceKind: document.kind,
            sourceSection: section.heading,
            excerpt: command,
            value: command,
          });
        }
      }
    }
  }
  return candidates;
}

function scoreEvidenceCandidate(target, candidate) {
  const normalizedTarget = normalizeProblemCandidate(target).toLowerCase();
  const normalizedCandidate = normalizeProblemCandidate(candidate).toLowerCase();
  if (!normalizedTarget || !normalizedCandidate) {
    return 0;
  }
  if (normalizedTarget === normalizedCandidate) {
    return 1;
  }
  const targetTokens = new Set(tokenizeEvidenceText(normalizedTarget));
  const candidateTokens = new Set(tokenizeEvidenceText(normalizedCandidate));
  let overlap = 0;
  for (const token of targetTokens) {
    if (candidateTokens.has(token)) {
      overlap += 1;
    }
  }
  const lexicalOverlap = targetTokens.size > 0 ? overlap / targetTokens.size : 0;
  const substringBoost = normalizedTarget.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedTarget)
    ? 0.22
    : 0;
  return lexicalOverlap + substringBoost;
}

function resolveDocumentationSourcesForSignal(signal, surface) {
  if (/cover surface|badge-led framing/i.test(signal)) {
    return [createEvidenceSource({
      sourcePath: surface.readmePath,
      sourceKind: 'readme',
      sourceSection: 'opening',
      excerpt: 'Centered hero and badge row detected in README opening.',
    })];
  }
  if (/anchor navigation/i.test(signal)) {
    return [createEvidenceSource({
      sourcePath: surface.readmePath,
      sourceKind: 'readme',
      sourceSection: 'opening',
      excerpt: 'README opening exposes anchor navigation links.',
    })];
  }
  if (/panel-like|product surface/i.test(signal)) {
    return [createEvidenceSource({
      sourcePath: surface.readmePath,
      sourceKind: 'readme',
      sourceSection: 'Product Surface',
      excerpt: 'README uses table and image panels to preview the product surface.',
    })];
  }
  if (/Mermaid/i.test(signal)) {
    return [createEvidenceSource({
      sourcePath: surface.architectureDocPath ?? surface.readmePath,
      sourceKind: surface.architectureDocPath ? 'doc' : 'readme',
      sourceSection: 'diagram',
      excerpt: 'Documentation contains Mermaid diagrams for system topology or flow.',
    })];
  }
  if (/split into focused docs/i.test(signal)) {
    return [
      createEvidenceSource({ sourcePath: surface.architectureDocPath, sourceKind: 'doc', sourceSection: 'Architecture', excerpt: 'Architecture guidance lives in a focused subdoc.' }),
      createEvidenceSource({ sourcePath: surface.troubleshootingDocPath, sourceKind: 'doc', sourceSection: 'Troubleshooting', excerpt: 'Troubleshooting guidance lives in a focused subdoc.' }),
    ].filter(Boolean);
  }
  if (/overview and data flow/i.test(signal)) {
    return [createEvidenceSource({
      sourcePath: surface.architectureDocPath,
      sourceKind: 'doc',
      sourceSection: 'Overview / Data Flow',
      excerpt: 'Architecture doc leads with Overview and Data Flow sections.',
    })].filter(Boolean);
  }
  if (/Symptoms|operator/i.test(signal)) {
    return [createEvidenceSource({
      sourcePath: surface.troubleshootingDocPath,
      sourceKind: 'doc',
      sourceSection: 'Symptoms / Checks',
      excerpt: 'Troubleshooting doc uses Symptoms and Checks blocks.',
    })].filter(Boolean);
  }
  if (/agent-facing guidance/i.test(signal)) {
    return (surface.agentGuidancePaths ?? []).slice(0, 2).map((relativePath) => createEvidenceSource({
      sourcePath: relativePath,
      sourceKind: /copilot-instructions/i.test(relativePath) ? 'agent-guidance' : 'doc',
      sourceSection: 'agent-guidance',
      excerpt: 'Explicit agent instruction surface detected.',
    }));
  }
  return [createEvidenceSource({
    sourcePath: surface.readmePath ?? surface.architectureDocPath,
    sourceKind: surface.readmePath ? 'readme' : 'doc',
    sourceSection: 'documentation-surface',
    excerpt: signal,
  })].filter(Boolean);
}

function resolveDocumentationSourcesForPattern(pattern, surface) {
  if (/README opening sequence pattern/i.test(pattern)) {
    return [createEvidenceSource({
      sourcePath: surface.readmePath,
      sourceKind: 'readme',
      sourceSection: 'opening',
      excerpt: 'Centered hero, badges, and anchor navigation appear together in the README opening.',
    })].filter(Boolean);
  }
  if (/GitHub showcase pattern/i.test(pattern)) {
    return [createEvidenceSource({
      sourcePath: surface.readmePath,
      sourceKind: 'readme',
      sourceSection: 'Product Surface',
      excerpt: 'README previews the product surface with table/image showcase panels.',
    })].filter(Boolean);
  }
  if (/Diagram placement pattern/i.test(pattern)) {
    return [createEvidenceSource({
      sourcePath: surface.architectureDocPath ?? surface.readmePath,
      sourceKind: surface.architectureDocPath ? 'doc' : 'readme',
      sourceSection: 'diagram',
      excerpt: 'Mermaid is used at topology or flow transitions instead of as decoration.',
    })].filter(Boolean);
  }
  if (/Documentation layout pattern/i.test(pattern)) {
    return [
      createEvidenceSource({ sourcePath: surface.readmePath, sourceKind: 'readme', sourceSection: 'opening', excerpt: 'README acts as the cover surface.' }),
      createEvidenceSource({ sourcePath: surface.architectureDocPath, sourceKind: 'doc', sourceSection: 'Architecture', excerpt: 'Architecture detail moves into a focused subdoc.' }),
      createEvidenceSource({ sourcePath: surface.troubleshootingDocPath, sourceKind: 'doc', sourceSection: 'Troubleshooting', excerpt: 'Troubleshooting detail moves into a focused subdoc.' }),
    ].filter(Boolean);
  }
  if (/Architecture document pattern/i.test(pattern)) {
    return [createEvidenceSource({
      sourcePath: surface.architectureDocPath,
      sourceKind: 'doc',
      sourceSection: 'Overview / Data Flow',
      excerpt: 'Architecture doc sequences Overview and Data Flow before deeper detail.',
    })].filter(Boolean);
  }
  if (/Troubleshooting pattern/i.test(pattern)) {
    return [createEvidenceSource({
      sourcePath: surface.troubleshootingDocPath,
      sourceKind: 'doc',
      sourceSection: 'Symptoms / Checks',
      excerpt: 'Troubleshooting doc is structured around symptoms, checks, and recovery.',
    })].filter(Boolean);
  }
  if (/Agent guidance pattern/i.test(pattern)) {
    return (surface.agentGuidancePaths ?? []).slice(0, 2).map((relativePath) => createEvidenceSource({
      sourcePath: relativePath,
      sourceKind: /copilot-instructions/i.test(relativePath) ? 'agent-guidance' : 'doc',
      sourceSection: 'agent-guidance',
      excerpt: 'Agent guidance files are boundary-led and explicit about forbidden regressions.',
    }));
  }
  if (/README pacing pattern/i.test(pattern)) {
    return [createEvidenceSource({
      sourcePath: surface.readmePath,
      sourceKind: 'readme',
      sourceSection: 'README pacing',
      excerpt: 'README headings show product story first, onboarding next, appendix last.',
    })].filter(Boolean);
  }
  if (/Progressive disclosure pattern/i.test(pattern)) {
    return [createEvidenceSource({
      sourcePath: surface.readmePath,
      sourceKind: 'readme',
      sourceSection: 'details',
      excerpt: 'README uses details blocks to hide secondary reference material.',
    })].filter(Boolean);
  }
  return [createEvidenceSource({
    sourcePath: surface.readmePath ?? surface.architectureDocPath,
    sourceKind: surface.readmePath ? 'readme' : 'doc',
    sourceSection: 'documentation-pattern',
    excerpt: pattern,
  })].filter(Boolean);
}

function findDocumentByName(documents, fileName) {
  return documents.find((document) => path.basename(document.relativePath) === fileName) ?? null;
}

function findDirectorySource(directories, pattern, excerpt) {
  const match = directories.find((directory) => pattern.test(directory));
  if (!match) {
    return null;
  }
  return createEvidenceSource({
    sourcePath: match,
    sourceKind: 'directory',
    sourceSection: 'top-level',
    excerpt,
  });
}

function findFileSource(files, fileName, excerpt) {
  const match = files.find((file) => path.basename(file.relativePath) === fileName);
  if (!match) {
    return null;
  }
  return createEvidenceSource({
    sourcePath: match.relativePath,
    sourceKind: 'manifest',
    sourceSection: 'entrypoint',
    excerpt,
  });
}

function tokenizeEvidenceText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function extractShellCommands(text) {
  const commands = [];
  for (const match of String(text ?? '').matchAll(/```(?:bash|sh|shell|zsh|console)?\n([\s\S]*?)```/g)) {
    const block = match[1] ?? '';
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/^\$\s*/, '').trim();
      if (!line || !isShellCommandCandidate(line)) {
        continue;
      }
      commands.push(line);
    }
  }
  return uniqueStrings(commands);
}

function detectEntryPoints(files) {
  const entryPointNames = new Set([
    'main.ts',
    'main.js',
    'main.py',
    'app.py',
    'server.ts',
    'server.js',
    'index.ts',
    'index.js',
    'Program.cs',
    'go.mod',
    'Cargo.toml',
    'package.json',
    'pubspec.yaml',
    'pom.xml',
  ]);
  return files
    .map((file) => file.relativePath)
    .filter((relativePath) => entryPointNames.has(path.basename(relativePath)))
    .slice(0, 10);
}

function buildSummary({ projectName, purpose, techStack, architecturePatterns }) {
  const stackFragment = techStack.slice(0, 4).join(', ');
  const patternFragment = architecturePatterns[0] ?? 'repository structure';
  const normalizedPurpose = cleanInlineMarkdown(purpose);
  return `${projectName}: ${normalizedPurpose}${stackFragment ? ` Stack: ${stackFragment}.` : ''} ${patternFragment}`.trim();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectObjectKeys(target, source) {
  if (!source || typeof source !== 'object') {
    return;
  }
  for (const key of Object.keys(source)) {
    target.add(key);
  }
}

function extractTomlArray(text, key) {
  const matcher = new RegExp(`${escapeRegExp(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
  const match = text.match(matcher);
  if (!match) {
    return [];
  }
  return match[1]
    .split(',')
    .map((value) => value.replace(/[#;].*$/g, '').trim())
    .map((value) => value.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function extractPoetryDependencies(text) {
  const sectionMatch = text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[[^\]]+\]|$)/m);
  if (!sectionMatch) {
    return [];
  }
  return sectionMatch[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => line.split('=')[0]?.trim() ?? '')
    .filter((line) => line && line !== 'python');
}

function extractTomlString(text, key) {
  const matcher = new RegExp(`${escapeRegExp(key)}\\s*=\\s*['\"]([^'\"]+)['\"]`, 'm');
  return text.match(matcher)?.[1]?.trim() ?? '';
}

function extractRequirements(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/g, '').trim())
    .filter(Boolean)
    .map((line) => stripVersionSpecifier(line));
}

function extractGoDependencies(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('module ') && !line.startsWith('go ') && !line.startsWith('replace '))
    .map((line) => line.replace(/^require\s+/, '').trim())
    .map((line) => line.split(' ')[0]?.trim() ?? '')
    .filter((line) => line && line !== '(' && line !== ')');
}

function extractCargoDependencies(text) {
  const sectionMatch = text.match(/\[dependencies\]([\s\S]*?)(?:\n\[[^\]]+\]|$)/m);
  if (!sectionMatch) {
    return [];
  }
  return sectionMatch[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => line.split('=')[0]?.trim() ?? '')
    .filter(Boolean);
}

function extractCargoDescription(text) {
  const packageSection = text.match(/\[package\]([\s\S]*?)(?:\n\[[^\]]+\]|$)/m)?.[1] ?? '';
  return extractTomlString(packageSection, 'description');
}

function extractXmlTagValues(text, tagName) {
  const matcher = new RegExp(`<${tagName}>([^<]+)</${tagName}>`, 'g');
  const values = [];
  for (const match of text.matchAll(matcher)) {
    values.push(match[1].trim());
  }
  return values;
}

function extractGradleDependencies(text) {
  const matches = [];
  for (const match of text.matchAll(/['"]([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([^'"]+)['"]/g)) {
    matches.push(match[2]);
  }
  return matches;
}

function extractYamlDependencyKeys(text) {
  const sectionMatch = text.match(/\ndependencies:\s*\n([\s\S]*?)(?:\n[a-zA-Z0-9_-]+:\s|$)/m);
  if (!sectionMatch) {
    return [];
  }
  return sectionMatch[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && /:/.test(line))
    .map((line) => line.split(':')[0]?.trim() ?? '')
    .filter((line) => line && line !== 'sdk');
}

function extractYamlScalar(text, key) {
  const matcher = new RegExp(`^${escapeRegExp(key)}:\s*(.+)$`, 'm');
  return text.match(matcher)?.[1]?.trim()?.replace(/^['"]|['"]$/g, '') ?? '';
}

function extractCsprojReferences(text) {
  const references = [];
  for (const match of text.matchAll(/<PackageReference[^>]+Include="([^"]+)"/g)) {
    references.push(match[1]);
  }
  for (const match of text.matchAll(/<FrameworkReference[^>]+Include="([^"]+)"/g)) {
    references.push(match[1]);
  }
  return references;
}

function extractExcerpt(text) {
  const plain = markdownToText(text)
    .split('\n')
    .map((line) => cleanInlineMarkdown(line.trim()))
    .filter(Boolean);
  return plain.find((line) => line.length >= 48) ?? plain[0] ?? '';
}

function extractMarkdownHeadings(text) {
  return text
    .split('\n')
    .map((line) => cleanInlineMarkdown(line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim() ?? ''))
    .filter(Boolean)
    .slice(0, 12);
}

function extractDocumentSections(text) {
  const sections = [];
  let currentHeading = null;
  let currentLines = [];

  const flush = () => {
    const sectionText = currentLines.join('\n').trim();
    if (!currentHeading && !sectionText) {
      return;
    }
    sections.push({
      heading: currentHeading,
      text: sectionText,
    });
  };

  for (const rawLine of String(text ?? '').split('\n')) {
    const headingMatch = rawLine.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentHeading = cleanInlineMarkdown(headingMatch[1]?.trim() ?? '');
      currentLines = [];
      continue;
    }
    currentLines.push(rawLine);
  }

  flush();
  if (sections.length === 0) {
    return [{ heading: null, text: String(text ?? '').trim() }];
  }
  return sections.filter((section) => section.heading || section.text);
}

function extractBulletStatements(text) {
  return markdownToText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter((line) => line.length >= 24)
    .slice(0, 6);
}

function extractDescriptiveSentences(text) {
  return markdownToText(text)
    .replace(/\n+/g, ' ')
    .split(/[.!?]\s+/)
    .map((line) => cleanInlineMarkdown(line.trim()))
    .filter((line) => line.length >= 48)
    .slice(0, 8);
}

function normalizeProblemCandidate(value) {
  return cleanInlineMarkdown(String(value ?? '').replace(/\s+/g, ' ').trim());
}

function ensureTrailingPeriod(value) {
  const normalized = normalizeProblemCandidate(value);
  if (!normalized) {
    return '';
  }
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function isHighSignalProblemCandidate(candidate) {
  return BOUNDARY_SIGNAL_PATTERN.test(candidate) || /under [.~\/_A-Za-z0-9-]+|instead of|without /i.test(candidate);
}

function isHighSignalBoundaryCandidate(candidate) {
  return candidate.length >= 24 && candidate.length <= 180 && BOUNDARY_SIGNAL_PATTERN.test(candidate);
}

function isHighSignalPatternCandidate(candidate) {
  if (!candidate || candidate.length < 32 || candidate.length > 180) {
    return false;
  }
  if (!BOUNDARY_SIGNAL_PATTERN.test(candidate)) {
    return false;
  }
  return /^(keep|use|store|split|treat|extend|limit|surface|encode|preserve|avoid|prefer)\b/i.test(candidate) || / instead of /i.test(candidate);
}

function isShellCommandCandidate(candidate) {
  if (!/^(npm|pnpm|yarn|bun|node|python|pytest|go\s+test|cargo\s+test|dotnet|mvn|gradle|flutter)\b/i.test(candidate)) {
    return false;
  }
  return VALIDATION_SIGNAL_PATTERN.test(candidate);
}

function isUsefulValidationSurface(candidate) {
  if (!candidate) {
    return false;
  }
  if (candidate.length < 12 || candidate.length > 220) {
    return false;
  }
  return VALIDATION_SIGNAL_PATTERN.test(candidate);
}

function isUsefulProblemCandidate(candidate, projectName) {
  if (!candidate) {
    return false;
  }

  const normalized = candidate.toLowerCase();
  if (normalized === String(projectName).toLowerCase()) {
    return false;
  }
  if (candidate.length < 32) {
    return false;
  }
  if (candidate.length > 180) {
    return false;
  }
  if (/^(optional|requires?|provider|consumer brand|internal\/project name|first production|admin:|playwright browsers)/i.test(candidate)) {
    return false;
  }
  if (/^(docker|api keys?|keytar|ios|ipad|react \+ typescript)\b/i.test(normalized)) {
    return false;
  }
  if (/locally indexed software project tracked inside the ai brain vault/i.test(normalized)) {
    return false;
  }
  if (/^happy path\b|^what it does\b|^what it does not do\b/i.test(normalized)) {
    return false;
  }
  return true;
}

function markdownToText(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^>\s?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanInlineMarkdown(text) {
  return text
    .replace(/(^|\s)\*\*([^*]+)\*\*(?=\s|$)/g, '$1$2')
    .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1$2')
    .replace(/(^|\s)__([^_]+)__(?=\s|$)/g, '$1$2')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim();
}

function stripVersionSpecifier(value) {
  return value
    .split(/[<>=!~\[\] ;]/)[0]
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

function normalizeRelativePath(rootPath, filePath) {
  return path.relative(rootPath, filePath).split(path.sep).join('/');
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}