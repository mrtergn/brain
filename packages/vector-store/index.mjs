import path from 'node:path';
import { spawn } from 'node:child_process';

import { BRAIN_ROOT, exists } from '../shared/index.mjs';

const sidecarPath = path.join(BRAIN_ROOT, 'scripts', 'python', 'chroma_sidecar.py');

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

async function runChromaSidecar(config, action, payload) {
  const pythonExecutable = await resolvePythonExecutable(config);
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

async function resolvePythonExecutable(config) {
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
  return new Promise((resolve) => {
    const child = spawn(candidate, ['-c', 'import chromadb'], {
      cwd: BRAIN_ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('close', (code) => {
      resolve(code === 0);
    });
    child.on('error', () => {
      resolve(false);
    });
  });
}

function looksLikePath(value) {
  return String(value).startsWith('.') || String(value).startsWith('~') || String(value).includes(path.sep);
}