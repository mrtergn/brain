import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cosineSimilarity, exists, timestamp } from '../shared/index.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const brainRoot = path.resolve(moduleDirectory, '..', '..');
const embedderScriptPath = path.join(brainRoot, 'scripts', 'python', 'embedder.py');
const DEFAULT_DIMENSIONS = 384;
const DEFAULT_MODEL = 'all-MiniLM-L6-v2';
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_PREWARM_TIMEOUT_MS = 12000;
const DEFAULT_PREWARM_TEXT = 'brain embedder prewarm';

let sharedService = null;
let sharedServicePromise = null;
let sharedPrewarmPromise = null;
const resolvedPythonExecutableCache = new Map();
const pythonValidationCache = new Map();
let lastPrewarmStatus = null;

export class SemanticEmbedder {
  constructor({ dimensions = DEFAULT_DIMENSIONS, batchSize = DEFAULT_BATCH_SIZE, pythonExecutable = null } = {}) {
    this.dimensions = dimensions;
    this.batchSize = batchSize;
    this.pythonExecutable = pythonExecutable;
    this.backendId = `sentence-transformers:${DEFAULT_MODEL}`;
    this.modelName = DEFAULT_MODEL;
  }

  async embedText(text) {
    const vectors = await this.embedTexts([text]);
    return vectors[0] ?? new Array(this.dimensions).fill(0);
  }

  async embedTexts(texts) {
    if (!Array.isArray(texts) || texts.length === 0) {
      return [];
    }

    const service = await getSharedService(this.pythonExecutable);
    try {
      const vectors = await service.embedTexts(texts, { batchSize: this.batchSize });
      return vectors.map((vector) => resizeVector(vector, this.dimensions));
    } catch {
      await service.reset();
      const fallbackVectors = await runOneShotEmbedding(texts, {
        batchSize: this.batchSize,
        pythonExecutable: this.pythonExecutable,
      });
      return fallbackVectors.map((vector) => resizeVector(vector, this.dimensions));
    }
  }

  similarity(left, right) {
    return cosineSimilarity(left, right);
  }
}

export class LocalSemanticEmbedder extends SemanticEmbedder {}

export class HashingEmbedder extends LocalSemanticEmbedder {}

export async function shutdownEmbeddingService() {
  sharedPrewarmPromise = null;
  const service = sharedService ?? (sharedServicePromise ? await sharedServicePromise.catch(() => null) : null);
  sharedService = null;
  sharedServicePromise = null;
  if (service) {
    await service.close();
  }
}

export async function prewarmEmbeddingService({
  pythonExecutable = null,
  timeoutMs = DEFAULT_PREWARM_TIMEOUT_MS,
  reason = 'manual',
  strategy = 'blocking',
  sampleText = DEFAULT_PREWARM_TEXT,
} = {}) {
  if (sharedPrewarmPromise) {
    return sharedPrewarmPromise;
  }

  sharedPrewarmPromise = runEmbeddingPrewarm({
    pythonExecutable,
    timeoutMs,
    reason,
    strategy,
    sampleText,
  }).finally(() => {
    sharedPrewarmPromise = null;
  });

  return sharedPrewarmPromise;
}

export function getEmbeddingServiceStatus() {
  return {
    serviceState: resolveEmbeddingServiceState(),
    servicePid: sharedService?.processId ?? sharedService?.process?.pid ?? null,
    startedAt: sharedService?.startedAt ?? null,
    readyAt: sharedService?.readyAt ?? null,
    lastUsedAt: sharedService?.lastUsedAt ?? null,
    pythonExecutable: sharedService?.pythonExecutable ?? null,
    modelName: sharedService?.modelName ?? DEFAULT_MODEL,
    dimensions: sharedService?.dimensions ?? DEFAULT_DIMENSIONS,
    lastError: sharedService?.lastError ?? null,
    lastPrewarm: lastPrewarmStatus ? { ...lastPrewarmStatus } : null,
  };
}

export function summarizeEmbeddingBatch(chunks, vectors) {
  return {
    chunkCount: chunks.length,
    dimensions: vectors[0]?.length ?? DEFAULT_DIMENSIONS,
    firstChunkPreview: chunks[0]?.preview ?? 'none',
    model: DEFAULT_MODEL,
  };
}

function resolveEmbeddingServiceState() {
  if (sharedService?.closed) {
    return 'closed';
  }
  if (sharedService?.isReady()) {
    return 'ready';
  }
  if (sharedServicePromise) {
    return 'starting';
  }
  return 'idle';
}

async function runEmbeddingPrewarm({ pythonExecutable, timeoutMs, reason, strategy, sampleText }) {
  const startedAt = Date.now();
  const hadReadyService = Boolean(sharedService?.isReady());

  try {
    const service = await promiseWithTimeout((async () => {
      const warmService = await getSharedService(pythonExecutable);
      await warmService.embedTexts([sampleText], { batchSize: 1 });
      return warmService;
    })(), timeoutMs, `Embedder prewarm timed out after ${timeoutMs}ms.`);

    const outcome = hadReadyService ? 'reused' : 'ready';
    lastPrewarmStatus = buildPrewarmStatus({
      outcome,
      reason,
      strategy,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      service,
    });
    return { ...lastPrewarmStatus };
  } catch (error) {
    if (sharedService) {
      await sharedService.reset().catch(() => {});
    }
    const outcome = error?.code === 'EMBEDDER_PREWARM_TIMEOUT' ? 'timed-out' : 'failed';
    lastPrewarmStatus = buildPrewarmStatus({
      outcome,
      reason,
      strategy,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      error,
      service: sharedService,
    });
    return { ...lastPrewarmStatus };
  }
}

function buildPrewarmStatus({ outcome, reason, strategy, timeoutMs, durationMs, service = null, error = null }) {
  return {
    at: timestamp(),
    outcome,
    reason,
    strategy,
    timeoutMs,
    durationMs,
    servicePid: service?.processId ?? service?.process?.pid ?? null,
    pythonExecutable: service?.pythonExecutable ?? sharedService?.pythonExecutable ?? null,
    error: error ? String(error.message ?? error) : null,
  };
}

function promiseWithTimeout(promise, timeoutMs, message) {
  const normalizedTimeoutMs = Math.max(Number(timeoutMs ?? DEFAULT_PREWARM_TIMEOUT_MS), 1);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = new Error(message);
      error.code = 'EMBEDDER_PREWARM_TIMEOUT';
      reject(error);
    }, normalizedTimeoutMs);

    promise.then((value) => {
      clearTimeout(timeout);
      resolve(value);
    }).catch((error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function getSharedService(pythonExecutable = null) {
  if (sharedService && !sharedService.closed) {
    return sharedService;
  }
  if (!sharedServicePromise) {
    sharedServicePromise = createSharedService(pythonExecutable);
  }
  return sharedServicePromise;
}

async function createSharedService(preferredPythonExecutable = null) {
  const pythonExecutable = await resolvePythonExecutable(preferredPythonExecutable);
  const service = new PythonEmbeddingService(pythonExecutable);
  sharedService = service;
  try {
    await service.start();
    return service;
  } catch (error) {
    if (sharedService === service) {
      sharedService = null;
    }
    sharedServicePromise = null;
    throw error;
  }
}

class PythonEmbeddingService {
  constructor(pythonExecutable) {
    this.pythonExecutable = pythonExecutable;
    this.process = null;
    this.processId = null;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.nextRequestId = 1;
    this.closed = false;
    this.startedAt = null;
    this.readyAt = null;
    this.lastUsedAt = null;
    this.modelName = DEFAULT_MODEL;
    this.dimensions = DEFAULT_DIMENSIONS;
    this.lastError = null;
    this.startupResolve = null;
    this.startupReject = null;
    this.startupSettled = false;
    this.startupPromise = new Promise((resolve, reject) => {
      this.startupResolve = resolve;
      this.startupReject = reject;
    });
    this.exitHandler = () => {
      this.close();
    };
  }

  isReady() {
    return Boolean(this.readyAt && !this.closed);
  }

  async start() {
    await ensureScriptExists();
    this.startedAt = timestamp();
    this.process = spawn(this.pythonExecutable, [embedderScriptPath, '--server'], {
      cwd: brainRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout.on('data', (chunk) => {
      this.handleStdout(chunk.toString('utf8'));
    });

    this.process.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim();
      if (!message) {
        return;
      }
      this.lastError = message;
      for (const request of this.pending.values()) {
        request.stderr.push(message);
      }
    });

    this.process.on('error', (error) => {
      this.lastError = error.message;
      this.rejectStartup(error);
      this.rejectAllPending(error);
    });

    this.process.on('close', (code) => {
      if (!this.closed) {
        const error = new Error(`Embedding service exited with code ${code}`);
        this.lastError = error.message;
        this.rejectStartup(error);
        if (code !== 0) {
          this.rejectAllPending(error);
        }
      }
    });

    process.once('exit', this.exitHandler);
    await this.startupPromise;
  }

  async embedTexts(texts, { batchSize } = {}) {
    if (!this.process || this.closed) {
      throw new Error('Embedding service is not available.');
    }

    const requestId = String(this.nextRequestId++);
    const payload = {
      id: requestId,
      texts,
      batchSize,
    };
    this.lastUsedAt = timestamp();

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        stderr: [],
      });
      try {
        this.process.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  async reset() {
    await this.close();
    if (sharedService === this) {
      sharedService = null;
    }
    sharedServicePromise = null;
  }

  async close() {
    this.closed = true;
    process.off('exit', this.exitHandler);
    if (!this.startupSettled) {
      this.rejectStartup(new Error('Embedding service shut down before completing startup.'));
    }

    const child = this.process;
    if (!child) {
      this.process = null;
      return;
    }
    if (child.killed) {
      this.process = null;
      if (sharedService === this) {
        sharedService = null;
      }
      return;
    }

    await new Promise((resolve) => {
      let finished = false;
      const finalize = () => {
        if (finished) {
          return;
        }
        finished = true;
        resolve();
      };

      child.once('close', finalize);
      child.kill();
      setTimeout(finalize, 2000);
    });

    if (this.process === child) {
      this.process = null;
    }
    if (sharedService === this) {
      sharedService = null;
    }
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleResponseLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  handleResponseLine(line) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      const error = new Error(`Failed to parse embedding service output: ${line}`);
      this.lastError = error.message;
      this.rejectStartup(error);
      this.rejectAllPending(error);
      return;
    }

    if (String(payload.id ?? '') === 'startup') {
      if (payload.ok === false) {
        const error = new Error(payload.error ?? 'Embedding service startup failed.');
        this.lastError = error.message;
        this.rejectStartup(error);
        return;
      }
      this.processId = Number(payload.pid ?? this.process?.pid ?? 0) || (this.process?.pid ?? null);
      this.modelName = String(payload.model ?? DEFAULT_MODEL);
      this.dimensions = Number(payload.dimensions ?? DEFAULT_DIMENSIONS) || DEFAULT_DIMENSIONS;
      this.readyAt = timestamp();
      this.resolveStartup(payload);
      return;
    }

    const request = this.pending.get(String(payload.id ?? ''));
    if (!request) {
      return;
    }
    this.pending.delete(String(payload.id));

    if (payload.ok === false) {
      const stderr = request.stderr.length > 0 ? ` | ${request.stderr.join(' | ')}` : '';
      const error = new Error(`${payload.error ?? 'Embedding request failed'}${stderr}`);
      this.lastError = error.message;
      request.reject(error);
      return;
    }

    request.resolve(payload.embeddings ?? []);
  }

  rejectStartup(error) {
    if (this.startupSettled) {
      return;
    }
    this.startupSettled = true;
    this.startupReject?.(error);
    this.startupResolve = null;
    this.startupReject = null;
  }

  resolveStartup(payload) {
    if (this.startupSettled) {
      return;
    }
    this.startupSettled = true;
    this.startupResolve?.(payload);
    this.startupResolve = null;
    this.startupReject = null;
  }

  rejectAllPending(error) {
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
   }
 }
 
async function runOneShotEmbedding(texts, { batchSize, pythonExecutable: preferredPythonExecutable = null } = {}) {
  const pythonExecutable = await resolvePythonExecutable(preferredPythonExecutable);
  await ensureScriptExists();
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, [embedderScriptPath], {
      cwd: brainRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      reject(error);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Embedding fallback exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || '[]'));
      } catch {
        reject(new Error(`Failed to parse one-shot embedding output: ${stdout.trim()}`));
      }
    });

    child.stdin.write(JSON.stringify({ texts, batchSize }));
    child.stdin.end();
  });
}

async function resolvePythonExecutable(preferredPythonExecutable = null) {
  const cacheKey = preferredPythonExecutable ?? '__default__';
  if (!resolvedPythonExecutableCache.has(cacheKey)) {
    resolvedPythonExecutableCache.set(cacheKey, resolvePythonExecutableUncached(preferredPythonExecutable));
  }
  return resolvedPythonExecutableCache.get(cacheKey);
}

async function resolvePythonExecutableUncached(preferredPythonExecutable = null) {
  const candidates = [
    preferredPythonExecutable,
    process.env.BRAIN_EMBEDDER_PYTHON,
    process.env.BRAIN_PYTHON,
    process.env.BRAIN_PYTHON_EXECUTABLE,
    path.join(brainRoot, '.venv', 'bin', 'python'),
    path.join(brainRoot, '.venv-embed', 'bin', 'python'),
    'python3',
    'python',
    '/usr/bin/python3',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (looksLikePath(candidate) && !(await exists(candidate))) {
      continue;
    }
    const isValid = await validatePythonExecutable(candidate);
    if (isValid) {
      return candidate;
    }
  }

  throw new Error('No Python environment with sentence-transformers was found. Run npm run brain:bootstrap:python or set BRAIN_PYTHON.');
}

async function validatePythonExecutable(pythonExecutable) {
  if (!pythonValidationCache.has(pythonExecutable)) {
    pythonValidationCache.set(pythonExecutable, new Promise((resolve) => {
      const child = spawn(pythonExecutable, ['-c', 'import importlib.util, json; print(json.dumps({"ok": importlib.util.find_spec("sentence_transformers") is not None}))'], {
        cwd: brainRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.on('close', (code) => {
        if (code !== 0) {
          resolve(false);
          return;
        }
        try {
          const payload = JSON.parse(stdout.trim());
          resolve(Boolean(payload.ok));
        } catch {
          resolve(false);
        }
      });
      child.on('error', () => {
        resolve(false);
      });
    }));
  }
  return pythonValidationCache.get(pythonExecutable);
}

function resizeVector(vector, dimensions) {
  if (!Array.isArray(vector)) {
    return new Array(dimensions).fill(0);
  }
  if (!Number.isFinite(dimensions) || dimensions <= 0 || vector.length === dimensions) {
    return vector;
  }
  if (vector.length > dimensions) {
    return vector.slice(0, dimensions);
  }
  return [...vector, ...new Array(dimensions - vector.length).fill(0)];
}

async function ensureScriptExists() {
  if (!(await exists(embedderScriptPath))) {
    throw new Error(`Python embedder script was not found at ${embedderScriptPath}`);
  }
}

function looksLikePath(value) {
  return String(value).startsWith('.') || String(value).startsWith('~') || String(value).includes(path.sep);
}
