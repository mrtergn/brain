import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_FILE_NAME = 'brain.config.json';
const DEFAULT_STATE_FILE_NAME = 'brain-state.json';
const DEFAULT_COLLECTION_NAME = 'brain_memory';

export const BRAIN_ROOT = path.resolve(moduleDirectory, '..', '..');
export const DEFAULT_PATHS = buildDefaultPaths();

export const VAULT_FOLDERS = [
  '00_Inbox',
  '01_Projects',
  '02_Experiments',
  '03_Agent_Notes',
  '04_Knowledge_Base',
  '05_Daily_Logs',
  '06_Summaries',
  '99_System',
];

export const PROJECT_NOTE_TYPES = ['overview', 'architecture', 'learnings', 'prompts'];

export const SOURCE_IGNORE_NAMES = new Set([
  '.git',
  '.github',
  '.idea',
  '.vscode',
  '.next',
  '.nuxt',
  '.turbo',
  '.yarn',
  '.pnpm-store',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  'target',
  'vendor',
  'tmp',
  'temp',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  'DerivedData',
  'Pods',
  'Library',
  'PackageCache',
  'obj',
  'bin',
  'runs',
  'third_party',
]);

export const LARGE_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.mp4',
  '.mov',
  '.mp3',
  '.wav',
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.pdf',
  '.sqlite',
  '.db',
  '.dylib',
  '.so',
  '.a',
  '.o',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.icns',
  '.ico',
]);

export function timestamp() {
  return new Date().toISOString();
}

export function normalizeSlashes(value) {
  return String(value).split(path.sep).join('/');
}

export function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

export function truncate(text, maxLength = 320) {
  const value = String(text ?? '');
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

export function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export async function ensureDir(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
}

export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallbackValue = null) {
  try {
    const payload = await fs.readFile(filePath, 'utf8');
    return JSON.parse(payload);
  } catch {
    return fallbackValue;
  }
}

export async function writeJson(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export async function writeText(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf8');
}

export async function appendLog(logPath, message) {
  await ensureDir(path.dirname(logPath));
  await fs.appendFile(logPath, `[${timestamp()}] ${message}\n`, 'utf8');
}

export async function readText(filePath, fallbackValue = '') {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return fallbackValue;
  }
}

export async function listTopLevelProjectRoots(projectsRoot, { includeBrain = false, explicitProjects = [] } = {}) {
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  const explicitSet = new Set(explicitProjects.filter(Boolean));
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .filter((entry) => includeBrain || entry.name !== 'brain' || explicitSet.has('brain'))
    .filter((entry) => explicitSet.size === 0 || explicitSet.has(entry.name))
    .map((entry) => path.join(projectsRoot, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export function isIgnoredPathSegment(segment) {
  return SOURCE_IGNORE_NAMES.has(segment);
}

export function shouldIgnoreSourcePath(relativePath) {
  return normalizeSlashes(relativePath)
    .split('/')
    .some((segment) => isIgnoredPathSegment(segment));
}

export function buildRuntimeConfig(args = {}) {
  const localConfig = loadLocalConfig(args);
  const configDir = localConfig.path ? path.dirname(localConfig.path) : BRAIN_ROOT;
  const defaultPaths = buildDefaultPaths();

  const projectsRootSetting = resolveSetting(args, {
    argKeys: ['projectsRoot', 'projects-root'],
    envKeys: ['BRAIN_PROJECTS_ROOT'],
    configValue: localConfig.data.projectsRoot,
    fallback: defaultPaths.projectsRoot,
  });
  const vaultRootSetting = resolveSetting(args, {
    argKeys: ['vaultRoot', 'vault-root'],
    envKeys: ['BRAIN_VAULT_ROOT'],
    configValue: localConfig.data.vaultRoot,
    fallback: defaultPaths.vaultRoot,
  });
  const dataRootSetting = resolveSetting(args, {
    argKeys: ['dataRoot', 'data-root'],
    envKeys: ['BRAIN_DATA_ROOT'],
    configValue: localConfig.data.dataRoot,
    fallback: defaultPaths.dataRoot,
  });

  const projectsRoot = resolvePathSetting(projectsRootSetting, configDir);
  const vaultRoot = resolvePathSetting(vaultRootSetting, configDir);
  const dataRoot = resolvePathSetting(dataRootSetting, configDir);
  const cacheRoot = resolvePathSetting(resolveSetting(args, {
    argKeys: ['cacheRoot', 'cache-root'],
    envKeys: ['BRAIN_CACHE_ROOT'],
    configValue: localConfig.data.cacheRoot,
    fallback: path.join(dataRoot, 'cache'),
  }), configDir);
  const projectCacheRoot = resolvePathSetting(resolveSetting(args, {
    argKeys: ['projectCacheRoot', 'project-cache-root'],
    envKeys: ['BRAIN_PROJECT_CACHE_ROOT'],
    configValue: localConfig.data.projectCacheRoot,
    fallback: path.join(cacheRoot, 'projects'),
  }), configDir);
  const chunkCacheRoot = resolvePathSetting(resolveSetting(args, {
    argKeys: ['chunkCacheRoot', 'chunk-cache-root'],
    envKeys: ['BRAIN_CHUNK_CACHE_ROOT'],
    configValue: localConfig.data.chunkCacheRoot,
    fallback: path.join(cacheRoot, 'chunks'),
  }), configDir);
  const stateRoot = resolvePathSetting(resolveSetting(args, {
    argKeys: ['stateRoot', 'state-root'],
    envKeys: ['BRAIN_STATE_ROOT'],
    configValue: localConfig.data.stateRoot,
    fallback: path.join(dataRoot, 'state'),
  }), configDir);
  const logRoot = resolvePathSetting(resolveSetting(args, {
    argKeys: ['logRoot', 'log-root'],
    envKeys: ['BRAIN_LOG_ROOT'],
    configValue: localConfig.data.logRoot,
    fallback: path.join(dataRoot, 'logs'),
  }), configDir);
  const chromaRoot = resolvePathSetting(resolveSetting(args, {
    argKeys: ['chromaRoot', 'chroma-root'],
    envKeys: ['BRAIN_CHROMA_ROOT'],
    configValue: localConfig.data.chromaRoot,
    fallback: path.join(dataRoot, 'chroma'),
  }), configDir);
  const runtimeRoot = resolvePathSetting(resolveSetting(args, {
    argKeys: ['runtimeRoot', 'runtime-root'],
    envKeys: ['BRAIN_RUNTIME_ROOT'],
    configValue: localConfig.data.runtimeRoot,
    fallback: path.join(dataRoot, 'runtime'),
  }), configDir);
  const promptsRoot = resolvePathSetting(resolveSetting(args, {
    argKeys: ['promptsRoot', 'prompts-root'],
    envKeys: ['BRAIN_PROMPTS_ROOT'],
    configValue: localConfig.data.promptsRoot,
    fallback: path.join(BRAIN_ROOT, 'prompts'),
  }), configDir);
  const statePath = resolvePathSetting(resolveSetting(args, {
    argKeys: ['statePath', 'state-path'],
    envKeys: ['BRAIN_STATE_PATH'],
    configValue: localConfig.data.statePath,
    fallback: path.join(stateRoot, DEFAULT_STATE_FILE_NAME),
  }), configDir);
  const pythonExecutable = resolveExecutableSetting(resolveSetting(args, {
    argKeys: ['pythonExecutable', 'python'],
    envKeys: ['BRAIN_PYTHON', 'BRAIN_PYTHON_EXECUTABLE'],
    configValue: localConfig.data.pythonExecutable,
    fallback: path.join(BRAIN_ROOT, '.venv', 'bin', 'python'),
  }), configDir);
  const collectionName = resolveStringSetting(resolveSetting(args, {
    argKeys: ['collectionName', 'collection-name'],
    envKeys: ['BRAIN_COLLECTION_NAME'],
    configValue: localConfig.data.collectionName,
    fallback: DEFAULT_COLLECTION_NAME,
  }));
  const watchMode = resolveStringSetting(resolveSetting(args, {
    argKeys: ['watchMode', 'watch-mode'],
    envKeys: ['BRAIN_WATCH_MODE'],
    configValue: localConfig.data.watchMode,
    fallback: 'auto',
  }));
  const pollIntervalMs = resolveNumberSetting(resolveSetting(args, {
    argKeys: ['pollIntervalMs', 'poll-interval'],
    envKeys: ['BRAIN_POLL_INTERVAL_MS'],
    configValue: localConfig.data.pollIntervalMs,
    fallback: 60000,
  }), 60000);
  const topK = resolveNumberSetting(resolveSetting(args, {
    argKeys: ['topK', 'top-k'],
    envKeys: ['BRAIN_TOP_K'],
    configValue: localConfig.data.topK,
    fallback: 6,
  }), 6);
  const runtimeScriptPath = path.join(BRAIN_ROOT, 'apps', 'cli', 'index.mjs');

  return {
    brainRoot: BRAIN_ROOT,
    configFilePath: localConfig.path,
    projectsRoot,
    vaultRoot,
    dataRoot,
    cacheRoot,
    projectCacheRoot,
    chunkCacheRoot,
    stateRoot,
    logRoot,
    chromaRoot,
    promptsRoot,
    runtimeRoot,
    runtimeAssetsRoot: runtimeRoot,
    runtimeScriptPath,
    statePath,
    runnerPath: path.join(runtimeRoot, 'run-brain.sh'),
    mcpRunnerPath: path.join(runtimeRoot, 'run-brain-mcp.sh'),
    launchdPlistPath: path.join(runtimeRoot, 'com.local.ai-brain.plist'),
    watchStdoutLogPath: path.join(runtimeRoot, 'brain-watch.stdout.log'),
    watchStderrLogPath: path.join(runtimeRoot, 'brain-watch.stderr.log'),
    watchMode,
    pollIntervalMs,
    collectionName,
    includeBrain: resolveBooleanSetting(resolveSetting(args, {
      argKeys: ['includeBrain', 'include-brain'],
      envKeys: ['BRAIN_INCLUDE_BRAIN'],
      configValue: localConfig.data.includeBrain,
      fallback: false,
    }), false),
    projectNames: args.projectNames ?? [],
    force: resolveBooleanSetting(resolveSetting(args, {
      argKeys: ['force'],
      envKeys: ['BRAIN_FORCE'],
      configValue: localConfig.data.force,
      fallback: false,
    }), false),
    topK,
    pythonExecutable,
    localReasonerOnly: resolveBooleanSetting(resolveSetting(args, {
      argKeys: ['localReasonerOnly', 'local-reasoner-only'],
      envKeys: ['BRAIN_LOCAL_REASONER_ONLY'],
      configValue: localConfig.data.localReasonerOnly,
      fallback: true,
    }), true),
  };
}

export function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    const key = token.slice(2);
    const nextValue = argv[index + 1];
    if (!nextValue || nextValue.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = nextValue;
    index += 1;
  }
  return result;
}

export function extractProjectNames(args) {
  const rawProject = args.project ?? args.projects ?? '';
  if (!rawProject) {
    return [];
  }
  return String(rawProject)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function buildLogPath(config, name = 'brain.log') {
  return path.join(config.logRoot, name);
}

export function createOperationSummary(items, noun) {
  if (items.length === 0) {
    return `0 ${noun}`;
  }
  return `${items.length} ${noun}: ${items.join(', ')}`;
}

function buildDefaultPaths() {
  const projectsRoot = path.dirname(BRAIN_ROOT);
  const vaultRoot = discoverDefaultVaultRoot();
  const dataRoot = path.join(BRAIN_ROOT, 'data');
  const cacheRoot = path.join(dataRoot, 'cache');
  const stateRoot = path.join(dataRoot, 'state');
  return {
    projectsRoot,
    vaultRoot,
    dataRoot,
    cacheRoot,
    projectCacheRoot: path.join(cacheRoot, 'projects'),
    chunkCacheRoot: path.join(cacheRoot, 'chunks'),
    stateRoot,
    logRoot: path.join(dataRoot, 'logs'),
    chromaRoot: path.join(dataRoot, 'chroma'),
    runtimeRoot: path.join(dataRoot, 'runtime'),
    promptsRoot: path.join(BRAIN_ROOT, 'prompts'),
    statePath: path.join(stateRoot, DEFAULT_STATE_FILE_NAME),
    chromaCollection: DEFAULT_COLLECTION_NAME,
  };
}

function discoverDefaultVaultRoot() {
  const candidates = [
    path.join(os.homedir(), 'Obsidian', 'Brain'),
    path.join(BRAIN_ROOT, 'obsidian-sync'),
  ];
  return candidates.find((candidate) => fsSync.existsSync(candidate)) ?? candidates[candidates.length - 1];
}

function loadLocalConfig(args) {
  const explicitConfigPath = args.configPath ?? args.config ?? process.env.BRAIN_CONFIG_PATH;
  const configPath = explicitConfigPath
    ? resolvePathFromBase(String(explicitConfigPath), process.cwd())
    : findDefaultConfigPath();

  if (!configPath || !fsSync.existsSync(configPath)) {
    return { path: null, data: {} };
  }

  try {
    const payload = JSON.parse(fsSync.readFileSync(configPath, 'utf8'));
    return {
      path: configPath,
      data: payload && typeof payload === 'object' ? payload : {},
    };
  } catch (error) {
    throw new Error(`Failed to read ${DEFAULT_CONFIG_FILE_NAME}: ${error.message}`);
  }
}

function findDefaultConfigPath() {
  const candidate = path.join(BRAIN_ROOT, DEFAULT_CONFIG_FILE_NAME);
  return fsSync.existsSync(candidate) ? candidate : null;
}

function resolveSetting(args, { argKeys = [], envKeys = [], configValue, fallback }) {
  for (const key of argKeys) {
    if (hasConfigValue(args[key])) {
      return { value: args[key], source: 'cli' };
    }
  }
  for (const key of envKeys) {
    if (hasConfigValue(process.env[key])) {
      return { value: process.env[key], source: 'env' };
    }
  }
  if (hasConfigValue(configValue)) {
    return { value: configValue, source: 'config' };
  }
  return { value: fallback, source: 'default' };
}

function hasConfigValue(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return true;
}

function resolvePathSetting(setting, configDir) {
  const basePath = setting.source === 'config' ? configDir : process.cwd();
  return resolvePathFromBase(String(setting.value), basePath);
}

function resolveExecutableSetting(setting, configDir) {
  const rawValue = String(setting.value).trim();
  if (!looksLikePath(rawValue)) {
    return rawValue;
  }
  const basePath = setting.source === 'config' ? configDir : process.cwd();
  return resolvePathFromBase(rawValue, basePath);
}

function resolveStringSetting(setting) {
  return String(setting.value).trim();
}

function resolveNumberSetting(setting, fallbackValue) {
  const numberValue = Number(setting.value);
  return Number.isFinite(numberValue) ? numberValue : fallbackValue;
}

function resolveBooleanSetting(setting, fallbackValue) {
  if (typeof setting.value === 'boolean') {
    return setting.value;
  }
  if (typeof setting.value === 'number') {
    return setting.value !== 0;
  }
  const normalized = String(setting.value).trim().toLowerCase();
  if (!normalized) {
    return fallbackValue;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallbackValue;
}

function resolvePathFromBase(rawValue, basePath) {
  const expandedValue = expandHomeDirectory(rawValue);
  return path.isAbsolute(expandedValue)
    ? path.resolve(expandedValue)
    : path.resolve(basePath, expandedValue);
}

function expandHomeDirectory(value) {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function looksLikePath(value) {
  return value.startsWith('.') || value.startsWith('~') || value.includes(path.sep);
}