import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cosineSimilarity, exists } from '../shared/index.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const brainRoot = path.resolve(moduleDirectory, '..', '..');
const embedderScriptPath = path.join(brainRoot, 'scripts', 'python', 'embedder.py');
const DEFAULT_DIMENSIONS = 384;
const DEFAULT_MODEL = 'all-MiniLM-L6-v2';
const DEFAULT_BATCH_SIZE = 32;

let sharedServicePromise = null;

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
  if (!sharedServicePromise) {
    return;
  }
  const service = await sharedServicePromise.catch(() => null);
  sharedServicePromise = null;
  if (service) {
    service.close();
  }
}

export function summarizeEmbeddingBatch(chunks, vectors) {
  return {
    chunkCount: chunks.length,
    dimensions: vectors[0]?.length ?? DEFAULT_DIMENSIONS,
    firstChunkPreview: chunks[0]?.preview ?? 'none',
    model: DEFAULT_MODEL,
  };
}

async function getSharedService(pythonExecutable = null) {
  if (!sharedServicePromise) {
    sharedServicePromise = PythonEmbeddingService.create(pythonExecutable);
  }
  return sharedServicePromise;
}

class PythonEmbeddingService {
  static async create(preferredPythonExecutable = null) {
    const pythonExecutable = await resolvePythonExecutable(preferredPythonExecutable);
    const service = new PythonEmbeddingService(pythonExecutable);
    await service.start();
    return service;
  }

  constructor(pythonExecutable) {
    this.pythonExecutable = pythonExecutable;
    this.process = null;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.nextRequestId = 1;
    this.closed = false;
  }

  async start() {
    await ensureScriptExists();
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
      for (const request of this.pending.values()) {
        request.stderr.push(message);
      }
    });

    this.process.on('error', (error) => {
      this.rejectAllPending(error);
    });

    this.process.on('close', (code) => {
      if (!this.closed && code !== 0) {
        this.rejectAllPending(new Error(`Embedding service exited with code ${code}`));
      }
    });

    process.once('exit', () => {
      this.close();
    });
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

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        stderr: [],
      });
      this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async reset() {
    this.close();
    sharedServicePromise = null;
  }

  close() {
    this.closed = true;
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
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
      this.rejectAllPending(new Error(`Failed to parse embedding service output: ${line}`));
      return;
    }

    const request = this.pending.get(String(payload.id ?? ''));
    if (!request) {
      return;
    }
    this.pending.delete(String(payload.id));

    if (payload.ok === false) {
      const stderr = request.stderr.length > 0 ? ` | ${request.stderr.join(' | ')}` : '';
      request.reject(new Error(`${payload.error ?? 'Embedding request failed'}${stderr}`));
      return;
    }

    request.resolve(payload.embeddings ?? []);
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
  return new Promise((resolve) => {
    const child = spawn(pythonExecutable, ['-c', 'import sentence_transformers, json; print(json.dumps({"ok": True, "version": sentence_transformers.__version__}))'], {
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
  });
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