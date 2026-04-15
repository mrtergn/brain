import path from 'node:path';
import { spawn } from 'node:child_process';

import { BRAIN_ROOT, exists } from '../shared/index.mjs';

const sidecarPath = path.join(BRAIN_ROOT, 'scripts', 'python', 'chroma_sidecar.py');
const sharedServicePromises = new Map();
const resolvedPythonExecutableCache = new Map();
const pythonValidationCache = new Map();

export class ChromaVectorStore {
  constructor(config) {
    this.config = config;
  }

  async status() {
    return runChromaSidecar(this.config, 'status', this.basePayload());
  }

  async ensureCollection() {
    return runChromaSidecar(this.config, 'ensure_collection', this.basePayload());
  }

  async upsert(chunks, embeddings) {
    return runChromaSidecar(this.config, 'upsert', {
      ...this.basePayload(),
      ids: chunks.map((chunk) => chunk.id),
      documents: chunks.map((chunk) => chunk.content),
      embeddings,
      metadatas: chunks.map((chunk) => chunk.metadata),
    });
  }

  async deleteIds(ids) {
    if (!ids || ids.length === 0) {
      return { ok: true, deletedCount: 0 };
    }
    return runChromaSidecar(this.config, 'delete_ids', {
      ...this.basePayload(),
      ids,
    });
  }

  async query(queryEmbedding, { topK = 6, where = null } = {}) {
    return runChromaSidecar(this.config, 'query', {
      ...this.basePayload(),
      queryEmbedding,
      topK,
      where,
    });
  }

  basePayload() {
    return {
      path: this.config.chromaRoot,
      collectionName: this.config.collectionName,
    };
  }
}

export async function shutdownChromaService() {
  const services = await Promise.all([...sharedServicePromises.values()].map((promise) => promise.catch(() => null)));
  sharedServicePromises.clear();
  await Promise.all(services.filter(Boolean).map((service) => service.close()));
}

async function runChromaSidecar(config, action, payload) {
  const service = await getSharedService(config);
  try {
    return await service.request(action, payload);
  } catch {
    await service.reset();
    return runOneShotSidecar(config, action, payload);
  }
}

async function getSharedService(config) {
  const key = buildServiceKey(config);
  if (!sharedServicePromises.has(key)) {
    sharedServicePromises.set(key, PythonChromaService.create(config, key));
  }
  return sharedServicePromises.get(key);
}

function buildServiceKey(config) {
  return [
    config.pythonExecutable ?? '',
    config.chromaRoot,
    config.collectionName,
  ].join('::');
}

class PythonChromaService {
  static async create(config, serviceKey) {
    const pythonExecutable = await resolvePythonExecutable(config);
    const service = new PythonChromaService({ pythonExecutable, serviceKey });
    await service.start();
    return service;
  }

  constructor({ pythonExecutable, serviceKey }) {
    this.pythonExecutable = pythonExecutable;
    this.serviceKey = serviceKey;
    this.process = null;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.nextRequestId = 1;
    this.closed = false;
    this.exitHandler = () => {
      this.close();
    };
  }

  async start() {
    await ensureScriptExists();
    this.process = spawn(this.pythonExecutable, [sidecarPath, '--server'], {
      cwd: BRAIN_ROOT,
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
        this.rejectAllPending(new Error(`Chroma sidecar exited with code ${code}`));
      }
    });

    process.once('exit', this.exitHandler);
  }

  async request(action, payload) {
    if (!this.process || this.closed) {
      throw new Error('Chroma sidecar is not available.');
    }

    const requestId = String(this.nextRequestId++);
    const message = {
      id: requestId,
      action,
      payload,
    };

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        stderr: [],
      });
      try {
        this.process.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  async reset() {
    await this.close();
    sharedServicePromises.delete(this.serviceKey);
  }

  async close() {
    this.closed = true;
    process.off('exit', this.exitHandler);
    const child = this.process;
    if (!child) {
      this.process = null;
      return;
    }
    if (child.killed) {
      this.process = null;
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
      this.rejectAllPending(new Error(`Failed to parse Chroma sidecar output: ${line}`));
      return;
    }

    const request = this.pending.get(String(payload.id ?? ''));
    if (!request) {
      return;
    }
    this.pending.delete(String(payload.id));

    if (payload.ok === false) {
      const stderr = request.stderr.length > 0 ? ` | ${request.stderr.join(' | ')}` : '';
      request.reject(new Error(`${payload.error ?? 'Chroma request failed'}${stderr}`));
      return;
    }

    request.resolve(payload.result ?? payload);
  }

  rejectAllPending(error) {
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
  }
}

async function runOneShotSidecar(config, action, payload) {
  const pythonExecutable = await resolvePythonExecutable(config);
  await ensureScriptExists();
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, [sidecarPath, action], {
      cwd: BRAIN_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      const trimmedStdout = stdout.trim();
      if (code !== 0) {
        reject(new Error(trimmedStdout || stderr.trim() || `Chroma sidecar exited with code ${code}`));
        return;
      }
      try {
        resolve(trimmedStdout ? JSON.parse(trimmedStdout) : {});
      } catch (error) {
        reject(new Error(`Failed to parse Chroma sidecar output: ${error.message}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function ensureScriptExists() {
  if (!(await exists(sidecarPath))) {
    throw new Error(`Python Chroma sidecar script was not found at ${sidecarPath}`);
  }
}

async function resolvePythonExecutable(config) {
  const cacheKey = [
    config.pythonExecutable ?? '',
    process.env.BRAIN_PYTHON ?? '',
    process.env.BRAIN_PYTHON_EXECUTABLE ?? '',
  ].join('::');
  if (!resolvedPythonExecutableCache.has(cacheKey)) {
    resolvedPythonExecutableCache.set(cacheKey, resolvePythonExecutableUncached(config));
  }
  return resolvedPythonExecutableCache.get(cacheKey);
}

async function resolvePythonExecutableUncached(config) {
  const fallbacks = [
    config.pythonExecutable,
    process.env.BRAIN_PYTHON,
    process.env.BRAIN_PYTHON_EXECUTABLE,
    path.join(BRAIN_ROOT, '.venv', 'bin', 'python'),
    path.join(BRAIN_ROOT, '.venv-embed', 'bin', 'python'),
    'python3',
    'python',
    '/usr/bin/python3',
  ].filter(Boolean);

  for (const candidate of fallbacks) {
    if (looksLikePath(candidate) && !(await exists(candidate))) {
      continue;
    }
    const isUsable = await validatePythonExecutable(candidate);
    if (isUsable) {
      return candidate;
    }
  }

  throw new Error('No usable Python interpreter with chromadb was found for the Chroma sidecar. Run npm run brain:bootstrap:python or set BRAIN_PYTHON.');
}

function validatePythonExecutable(candidate) {
  if (!pythonValidationCache.has(candidate)) {
    pythonValidationCache.set(candidate, new Promise((resolve) => {
      const child = spawn(candidate, ['-c', 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("chromadb") else 1)'], {
        cwd: BRAIN_ROOT,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('close', (code) => {
        resolve(code === 0);
      });
      child.on('error', () => {
        resolve(false);
      });
    }));
  }
  return pythonValidationCache.get(candidate);
}

function looksLikePath(value) {
  return String(value).startsWith('.') || String(value).startsWith('~') || String(value).includes(path.sep);
}