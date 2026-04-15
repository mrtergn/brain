import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  getEmbeddingServiceStatus,
  LocalSemanticEmbedder,
  SemanticEmbedder,
  shutdownEmbeddingService,
} from '../embeddings/index.mjs';
import {
  appendLog,
  buildLogPath,
  ensureDir,
  readJson,
  resolvePathFromBase,
  timestamp,
  writeJson,
} from '../shared/index.mjs';

const RUNNER_PROTOCOL_VERSION = 1;
const RUNNER_LOCK_STALE_MS = 30000;
const RUNNER_HEALTHCHECK_TIMEOUT_MS = 750;
const RUNNER_CONNECT_RETRY_INTERVAL_MS = 125;
const RUNNER_CONNECT_RETRY_TIMEOUT_MS = 5000;
const RUNNER_MESSAGE_LIMIT_BYTES = 1_000_000;

export class PersistentRunnerSemanticEmbedder extends SemanticEmbedder {
  constructor({ config, selection, dimensions = 384, batchSize = 32, pythonExecutable = null } = {}) {
    super({ dimensions, batchSize, pythonExecutable });
    this.config = config;
    this.selection = selection ?? null;
    this.lastRequestMeta = selection?.runnerStatus
      ? summarizeSelection(selection)
      : buildFallbackRuntimeMeta(selection?.mode ?? config?.embedderRunnerMode ?? 'off', 'runner was not selected');
    this.fallbackEmbedder = new LocalSemanticEmbedder({
      dimensions,
      batchSize,
      pythonExecutable: pythonExecutable ?? config?.pythonExecutable ?? null,
    });
  }

  async embedTexts(texts) {
    if (!Array.isArray(texts) || texts.length === 0) {
      return [];
    }

    const startedAt = Date.now();
    try {
      const response = await requestEmbedderRunner(this.config, 'embed', {
        texts,
        batchSize: this.batchSize,
      }, {
        timeoutMs: this.config.embedderRunnerRequestTimeoutMs,
      });
      this.lastRequestMeta = {
        backend: 'runner',
        mode: this.selection?.mode ?? this.config.embedderRunnerMode,
        usedRunner: true,
        durationMs: Date.now() - startedAt,
        runnerAction: this.selection?.startup?.action ?? 'connected',
        runnerPid: response.pid ?? this.selection?.runnerStatus?.pid ?? null,
        runnerState: 'running',
        model: response.model ?? this.selection?.runnerStatus?.model ?? this.modelName,
        dimensions: response.dimensions ?? this.selection?.runnerStatus?.dimensions ?? this.dimensions,
        socketPath: this.config.embedderRunnerSocketPath,
        fallbackReason: null,
        lastError: null,
      };
      return (response.embeddings ?? []).map((vector) => resizeVector(vector, this.dimensions));
    } catch (error) {
      this.lastRequestMeta = {
        backend: 'runner-failed',
        mode: this.selection?.mode ?? this.config.embedderRunnerMode,
        usedRunner: false,
        durationMs: Date.now() - startedAt,
        runnerAction: this.selection?.startup?.action ?? 'request-failed',
        runnerPid: this.selection?.runnerStatus?.pid ?? null,
        runnerState: 'unhealthy',
        model: this.selection?.runnerStatus?.model ?? this.modelName,
        dimensions: this.selection?.runnerStatus?.dimensions ?? this.dimensions,
        socketPath: this.config.embedderRunnerSocketPath,
        fallbackReason: error.message,
        lastError: error.message,
      };
      await stopEmbedderRunner(this.config, {
        force: true,
        reason: `runner request failed: ${error.message}`,
      }).catch(() => {});
      if (String(this.selection?.mode ?? this.config.embedderRunnerMode).trim().toLowerCase() === 'require') {
        throw new Error(`Persistent embedder runner is required but unavailable: ${error.message}`);
      }
      const vectors = await this.fallbackEmbedder.embedTexts(texts);
      this.lastRequestMeta = {
        ...this.lastRequestMeta,
        backend: 'in-process-fallback',
        runnerState: 'stopped',
        usedRunner: false,
      };
      return vectors;
    }
  }

  getLastRequestMeta() {
    return this.lastRequestMeta ? { ...this.lastRequestMeta } : null;
  }
}

export function createCliSemanticEmbedder(config, { selection = null } = {}) {
  if (selection?.backend === 'runner') {
    return new PersistentRunnerSemanticEmbedder({
      config,
      selection,
      pythonExecutable: config.pythonExecutable,
    });
  }
  return new LocalSemanticEmbedder({ pythonExecutable: config.pythonExecutable });
}

export function describeEmbedderRuntime(embedder, selection = null) {
  const runtimeMeta = embedder?.getLastRequestMeta?.() ?? null;
  if (runtimeMeta) {
    return runtimeMeta;
  }
  if (selection) {
    return selection.backend === 'runner'
      ? summarizeSelection(selection)
      : buildFallbackRuntimeMeta(selection.mode, selection.fallbackReason ?? 'runner was not selected');
  }
  return buildFallbackRuntimeMeta('off', 'runner diagnostics unavailable');
}

export async function resolveCliEmbedderSelection(config, {
  command,
  allowAutoStart = false,
} = {}) {
  const mode = normalizeRunnerMode(config.embedderRunnerMode);
  const runnerStatus = await inspectEmbedderRunner(config);
  if (mode === 'off') {
    return {
      mode,
      backend: 'in-process',
      usedRunner: false,
      fallbackReason: 'runner disabled by configuration',
      runnerStatus,
      startup: null,
    };
  }

  if (runnerStatus.running) {
    return {
      mode,
      backend: 'runner',
      usedRunner: true,
      fallbackReason: null,
      runnerStatus,
      startup: {
        action: 'already-running',
        durationMs: 0,
        error: null,
      },
    };
  }

  if (mode === 'require' || allowAutoStart) {
    try {
      const startResult = await startEmbedderRunner(config, {
        reason: `${command ?? 'cli'} requested persistent embedder reuse`,
      });
      return {
        mode,
        backend: 'runner',
        usedRunner: true,
        fallbackReason: null,
        runnerStatus: startResult.status,
        startup: {
          action: startResult.action,
          durationMs: startResult.durationMs,
          error: null,
        },
      };
    } catch (error) {
      if (mode === 'require') {
        throw new Error(`Persistent embedder runner is required but unavailable: ${error.message}`);
      }
      return {
        mode,
        backend: 'in-process',
        usedRunner: false,
        fallbackReason: `runner unavailable, using in-process embedder: ${error.message}`,
        runnerStatus: await inspectEmbedderRunner(config),
        startup: {
          action: 'failed',
          durationMs: 0,
          error: error.message,
        },
      };
    }
  }

  return {
    mode,
    backend: 'in-process',
    usedRunner: false,
    fallbackReason: `${command ?? 'command'} is using the in-process embedder because the persistent runner is not running`,
    runnerStatus,
    startup: {
      action: 'skipped',
      durationMs: 0,
      error: null,
    },
  };
}

export async function inspectEmbedderRunner(config, { timeoutMs = RUNNER_HEALTHCHECK_TIMEOUT_MS } = {}) {
  const persisted = await loadRunnerState(config);
  const pidFromFile = await readRunnerPid(config);
  const persistedPid = persisted?.running ? persisted?.pid : null;
  const pid = pidFromFile ?? persistedPid ?? null;
  const pidAlive = pid ? isProcessRunning(pid) : false;
  let liveStatus = null;
  if (await existsSafe(config.embedderRunnerSocketPath)) {
    try {
      liveStatus = await requestEmbedderRunner(config, 'status', {}, { timeoutMs });
    } catch {
      liveStatus = null;
    }
  }

  const staleReasons = [];
  if (pid && !pidAlive) {
    staleReasons.push('stale pid file');
  }
  if ((await existsSafe(config.embedderRunnerSocketPath)) && !liveStatus) {
    staleReasons.push('socket exists but runner is unreachable');
  }
  if (pidAlive && !(await existsSafe(config.embedderRunnerSocketPath))) {
    staleReasons.push('pid is alive but socket is missing');
  }

  const status = {
    mode: normalizeRunnerMode(config.embedderRunnerMode),
    running: Boolean(liveStatus?.ok),
    healthy: Boolean(liveStatus?.ok),
    stale: staleReasons.length > 0 && !liveStatus?.ok,
    staleReasons,
    pid: liveStatus?.pid ?? pid ?? null,
    socketPath: config.embedderRunnerSocketPath,
    statePath: config.embedderRunnerStatePath,
    lockPath: config.embedderRunnerLockPath,
    model: liveStatus?.model ?? persisted?.model ?? null,
    dimensions: liveStatus?.dimensions ?? persisted?.dimensions ?? null,
    startedAt: liveStatus?.startedAt ?? persisted?.startedAt ?? null,
    lastUsedAt: liveStatus?.lastUsedAt ?? persisted?.lastUsedAt ?? null,
    uptimeMs: liveStatus?.startedAt ? Math.max(Date.now() - Date.parse(liveStatus.startedAt), 0) : null,
    idleTimeoutMs: liveStatus?.idleTimeoutMs ?? persisted?.idleTimeoutMs ?? config.embedderRunnerIdleTimeoutMs,
    requestTimeoutMs: liveStatus?.requestTimeoutMs ?? persisted?.requestTimeoutMs ?? config.embedderRunnerRequestTimeoutMs,
    lastError: liveStatus?.lastError ?? persisted?.lastError ?? null,
    backendIfQueriedNow: computeBackendIfQueriedNow(config, Boolean(liveStatus?.ok)),
  };

  if (!status.running && status.stale) {
    await cleanupStaleRunnerArtifacts(config, status).catch(() => {});
  }

  return status;
}

export async function startEmbedderRunner(config, { reason = 'manual start' } = {}) {
  const startedAt = Date.now();
  const currentStatus = await inspectEmbedderRunner(config);
  if (currentStatus.running) {
    return { status: currentStatus, action: 'already-running', durationMs: 0 };
  }

  const releaseLock = await acquireRunnerLock(config);
  try {
    const lockedStatus = await inspectEmbedderRunner(config);
    if (lockedStatus.running) {
      return { status: lockedStatus, action: 'already-running', durationMs: Date.now() - startedAt };
    }

    await cleanupStaleRunnerArtifacts(config, lockedStatus);
    await Promise.all([
      ensureDir(config.runtimeRoot),
      ensureDir(config.logRoot),
    ]);
    await appendLog(buildLogPath(config), `Starting embedder runner | reason=${reason}`);

    const stdoutFd = fsSync.openSync(config.embedderRunnerStdoutLogPath, 'a');
    const stderrFd = fsSync.openSync(config.embedderRunnerStderrLogPath, 'a');
    try {
      const child = spawn(process.execPath, buildRunnerProcessArgs(config), {
        cwd: config.brainRoot,
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
      });
      child.unref();
    } finally {
      fsSync.closeSync(stdoutFd);
      fsSync.closeSync(stderrFd);
    }

    const status = await waitForRunnerHealthy(config, config.embedderRunnerStartupTimeoutMs);
    return {
      status,
      action: 'started',
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await releaseLock();
  }
}

export async function stopEmbedderRunner(config, {
  force = false,
  reason = 'manual stop',
} = {}) {
  const status = await inspectEmbedderRunner(config);
  if (!status.running && !status.pid) {
    await cleanupStaleRunnerArtifacts(config, status);
    return { status: await inspectEmbedderRunner(config), action: 'already-stopped' };
  }

  try {
    if (!force && status.running) {
      await requestEmbedderRunner(config, 'shutdown', { reason }, {
        timeoutMs: Math.min(config.embedderRunnerRequestTimeoutMs, 5000),
      });
    }
  } catch {
    // fall through to process-based shutdown
  }

  if (status.pid && isProcessRunning(status.pid)) {
    await terminateProcess(status.pid, 'SIGTERM');
    await waitForProcessExit(status.pid, 3000);
  }
  if (status.pid && isProcessRunning(status.pid)) {
    await terminateProcess(status.pid, 'SIGKILL');
    await waitForProcessExit(status.pid, 2000);
  }

  await cleanupStaleRunnerArtifacts(config, status);
  const nextStatus = await inspectEmbedderRunner(config);
  return { status: nextStatus, action: 'stopped' };
}

export async function restartEmbedderRunner(config, { reason = 'manual restart' } = {}) {
  await stopEmbedderRunner(config, { force: true, reason: `${reason} (stop)` });
  return startEmbedderRunner(config, { reason: `${reason} (start)` });
}

export async function requestEmbedderRunner(config, action, payload = {}, { timeoutMs = null } = {}) {
  const requestTimeoutMs = Math.max(Number(timeoutMs ?? config.embedderRunnerRequestTimeoutMs ?? RUNNER_HEALTHCHECK_TIMEOUT_MS), 1);
  const message = JSON.stringify({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    action,
    payload,
  });

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(config.embedderRunnerSocketPath);
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Embedder runner request timed out after ${requestTimeoutMs}ms.`));
    }, requestTimeoutMs);

    const finish = (error, value = null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    };

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${message}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > RUNNER_MESSAGE_LIMIT_BYTES) {
        finish(new Error('Embedder runner response exceeded the maximum supported size.'));
        return;
      }
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) {
        finish(new Error('Embedder runner returned an empty response.'));
        return;
      }
      try {
        const response = JSON.parse(line);
        if (response.ok === false) {
          finish(new Error(response.error ?? 'Embedder runner request failed.'));
          return;
        }
        finish(null, response);
      } catch (error) {
        finish(new Error(`Failed to parse embedder runner response: ${error.message}`));
      }
    });
    socket.on('error', (error) => {
      finish(error);
    });
  });
}

export async function writeEmbedderRunnerState(config, payload) {
  await ensureDir(path.dirname(config.embedderRunnerStatePath));
  await writeJson(config.embedderRunnerStatePath, payload);
}

export async function removeEmbedderRunnerArtifacts(config) {
  await Promise.all([
    removeFileIfExists(config.embedderRunnerSocketPath),
    removeFileIfExists(config.embedderRunnerPidPath),
    removeFileIfExists(config.embedderRunnerLockPath),
  ]);
}

export function normalizeRunnerMode(mode) {
  const normalized = String(mode ?? 'auto').trim().toLowerCase();
  if (['off', 'false', 'disabled', 'none'].includes(normalized)) {
    return 'off';
  }
  if (normalized === 'require') {
    return 'require';
  }
  return 'auto';
}

export async function loadRunnerState(config) {
  return readJson(config.embedderRunnerStatePath, null);
}

export function buildRunnerServerSnapshot(config, {
  pid,
  startedAt,
  lastUsedAt,
  lastError,
  model,
  dimensions,
} = {}) {
  return {
    pid,
    startedAt,
    lastUsedAt,
    lastError,
    model,
    dimensions,
    socketPath: config.embedderRunnerSocketPath,
    requestTimeoutMs: config.embedderRunnerRequestTimeoutMs,
    idleTimeoutMs: config.embedderRunnerIdleTimeoutMs,
    updatedAt: timestamp(),
  };
}

function buildRunnerProcessArgs(config) {
  const args = [path.join(config.brainRoot, 'apps', 'embedder-runner', 'index.mjs')];
  if (config.configFilePath) args.push('--config', config.configFilePath);
  if (config.dataRoot) args.push('--data-root', config.dataRoot);
  if (config.logRoot) args.push('--log-root', config.logRoot);
  if (config.statePath) args.push('--state-path', config.statePath);
  if (config.pythonExecutable) args.push('--python', config.pythonExecutable);
  args.push('--embedder-runner-mode', config.embedderRunnerMode);
  args.push('--embedder-runner-socket-path', config.embedderRunnerSocketPath);
  args.push('--embedder-runner-startup-timeout-ms', String(config.embedderRunnerStartupTimeoutMs));
  args.push('--embedder-runner-request-timeout-ms', String(config.embedderRunnerRequestTimeoutMs));
  args.push('--embedder-runner-idle-timeout-ms', String(config.embedderRunnerIdleTimeoutMs));
  return args;
}

async function waitForRunnerHealthy(config, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const status = await inspectEmbedderRunner(config, { timeoutMs: RUNNER_HEALTHCHECK_TIMEOUT_MS });
    if (status.running) {
      return status;
    }
    await wait(RUNNER_CONNECT_RETRY_INTERVAL_MS);
  }
  throw new Error(`Embedder runner did not become healthy within ${timeoutMs}ms.`);
}

async function acquireRunnerLock(config) {
  const startedAt = Date.now();
  const lockWaitTimeoutMs = Math.max(
    RUNNER_CONNECT_RETRY_TIMEOUT_MS,
    Number(config.embedderRunnerStartupTimeoutMs ?? 0) + 1000,
  );
  await ensureDir(path.dirname(config.embedderRunnerLockPath));
  while (Date.now() - startedAt <= lockWaitTimeoutMs) {
    try {
      const handle = await fs.open(config.embedderRunnerLockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: timestamp() }));
      return async () => {
        await handle.close().catch(() => {});
        await removeFileIfExists(config.embedderRunnerLockPath);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      const lockStats = await statIfExists(config.embedderRunnerLockPath);
      if (lockStats && Date.now() - lockStats.mtimeMs > RUNNER_LOCK_STALE_MS) {
        await removeFileIfExists(config.embedderRunnerLockPath);
        continue;
      }
      const status = await inspectEmbedderRunner(config, { timeoutMs: RUNNER_HEALTHCHECK_TIMEOUT_MS });
      if (status.running) {
        return async () => {};
      }
      await wait(RUNNER_CONNECT_RETRY_INTERVAL_MS);
    }
  }
  throw new Error('Timed out waiting for the embedder runner startup lock.');
}

async function cleanupStaleRunnerArtifacts(config, status = null) {
  const currentStatus = status ?? await inspectEmbedderRunner(config, { timeoutMs: RUNNER_HEALTHCHECK_TIMEOUT_MS });
  if (currentStatus.running) {
    return;
  }
  await removeFileIfExists(config.embedderRunnerSocketPath);
  if (!currentStatus.pid || !isProcessRunning(currentStatus.pid)) {
    await removeFileIfExists(config.embedderRunnerPidPath);
  }
  if (currentStatus.stale || currentStatus.lastError) {
    await writeEmbedderRunnerState(config, {
      ...(await loadRunnerState(config) ?? {}),
      running: false,
      pid: currentStatus.pid,
      socketPath: config.embedderRunnerSocketPath,
      lastError: (currentStatus.lastError ?? currentStatus.staleReasons.join('; ')) || null,
      updatedAt: timestamp(),
      model: currentStatus.model,
      dimensions: currentStatus.dimensions,
      idleTimeoutMs: currentStatus.idleTimeoutMs,
      requestTimeoutMs: currentStatus.requestTimeoutMs,
    });
  }
}

function summarizeSelection(selection) {
  return {
    backend: 'runner',
    mode: selection.mode,
    usedRunner: true,
    durationMs: selection.startup?.durationMs ?? 0,
    runnerAction: selection.startup?.action ?? 'already-running',
    runnerPid: selection.runnerStatus?.pid ?? null,
    runnerState: selection.runnerStatus?.running ? 'running' : 'stopped',
    model: selection.runnerStatus?.model ?? null,
    dimensions: selection.runnerStatus?.dimensions ?? null,
    socketPath: selection.runnerStatus?.socketPath ?? null,
    fallbackReason: null,
    lastError: selection.runnerStatus?.lastError ?? null,
  };
}

function buildFallbackRuntimeMeta(mode, fallbackReason) {
  return {
    backend: 'in-process',
    mode,
    usedRunner: false,
    durationMs: 0,
    runnerAction: 'not-used',
    runnerPid: null,
    runnerState: 'stopped',
    model: null,
    dimensions: null,
    socketPath: null,
    fallbackReason,
    lastError: null,
  };
}

function computeBackendIfQueriedNow(config, running) {
  const mode = normalizeRunnerMode(config.embedderRunnerMode);
  if (mode === 'off') {
    return 'in-process';
  }
  if (running) {
    return 'runner';
  }
  return mode === 'require' ? 'runner-required' : 'auto-start-runner';
}

function resizeVector(vector, dimensions) {
  const normalized = Array.isArray(vector) ? vector : [];
  if (normalized.length === dimensions) {
    return normalized;
  }
  if (normalized.length > dimensions) {
    return normalized.slice(0, dimensions);
  }
  return [...normalized, ...new Array(dimensions - normalized.length).fill(0)];
}

async function readRunnerPid(config) {
  try {
    const raw = await fs.readFile(config.embedderRunnerPidPath, 'utf8');
    const pid = Number(String(raw).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function writeRunnerPid(config, pid) {
  await ensureDir(path.dirname(config.embedderRunnerPidPath));
  await fs.writeFile(config.embedderRunnerPidPath, `${pid}\n`, 'utf8');
}

export function isProcessRunning(pid) {
  if (!pid || !Number.isInteger(Number(pid)) || Number(pid) <= 0) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcess(pid, signal) {
  if (!pid || !isProcessRunning(pid)) {
    return;
  }
  process.kill(pid, signal);
}

async function waitForProcessExit(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await wait(100);
  }
  return !isProcessRunning(pid);
}

async function removeFileIfExists(filePath) {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // ignore cleanup failures
  }
}

async function existsSafe(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function statIfExists(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function wait(durationMs) {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export async function runEmbedderRunnerServer(config) {
  await Promise.all([
    ensureDir(config.runtimeRoot),
    ensureDir(config.logRoot),
  ]);
  await cleanupStaleRunnerArtifacts(config);

  const startup = await import('../embeddings/index.mjs').then(({ prewarmEmbeddingService }) => prewarmEmbeddingService({
    pythonExecutable: config.pythonExecutable,
    timeoutMs: config.embedderRunnerStartupTimeoutMs,
    reason: 'cli-runner-startup',
    strategy: 'blocking',
  }));
  if (!['ready', 'reused'].includes(startup.outcome)) {
    throw new Error(startup.error ?? `Embedder runner startup failed with outcome ${startup.outcome}`);
  }

  const embedderStatus = getEmbeddingServiceStatus();
  await writeRunnerPid(config, process.pid);

  const embedder = new LocalSemanticEmbedder({ pythonExecutable: config.pythonExecutable });
  let lastUsedAt = embedderStatus.lastUsedAt ?? timestamp();
  let lastError = null;
  let idleTimer = null;

  const refreshState = async () => {
    const liveStatus = getEmbeddingServiceStatus();
    await writeEmbedderRunnerState(config, {
      running: true,
      pid: process.pid,
      startedAt: liveStatus.startedAt ?? timestamp(),
      lastUsedAt,
      lastError,
      model: liveStatus.modelName ?? embedder.modelName,
      dimensions: liveStatus.dimensions ?? embedder.dimensions,
      socketPath: config.embedderRunnerSocketPath,
      idleTimeoutMs: config.embedderRunnerIdleTimeoutMs,
      requestTimeoutMs: config.embedderRunnerRequestTimeoutMs,
      updatedAt: timestamp(),
    });
  };

  const scheduleIdleTimeout = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const normalizedIdleTimeoutMs = Math.max(Number(config.embedderRunnerIdleTimeoutMs ?? 0), 0);
    if (normalizedIdleTimeoutMs === 0) {
      return;
    }
    idleTimer = setTimeout(() => {
      shutdown('idle-timeout');
    }, normalizedIdleTimeoutMs);
  };

  const shutdown = async (reason) => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    await appendLog(buildLogPath(config), `Stopping embedder runner | reason=${reason}`);
    await shutdownEmbeddingService();
    await writeEmbedderRunnerState(config, {
      running: false,
      pid: process.pid,
      startedAt: embedderStatus.startedAt ?? null,
      lastUsedAt,
      lastError,
      model: embedderStatus.modelName ?? embedder.modelName,
      dimensions: embedderStatus.dimensions ?? embedder.dimensions,
      socketPath: config.embedderRunnerSocketPath,
      idleTimeoutMs: config.embedderRunnerIdleTimeoutMs,
      requestTimeoutMs: config.embedderRunnerRequestTimeoutMs,
      stoppedAt: timestamp(),
      updatedAt: timestamp(),
    });
    await removeEmbedderRunnerArtifacts(config);
    server.close(() => {
      process.exit(0);
    });
  };

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', async (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > RUNNER_MESSAGE_LIMIT_BYTES) {
        socket.write(`${JSON.stringify({ ok: false, error: 'Request exceeded the maximum supported size.' })}\n`);
        socket.end();
        return;
      }
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        socket.write(`${JSON.stringify({ ok: false, error: 'Invalid JSON payload.' })}\n`);
        socket.end();
        return;
      }

      const action = String(message.action ?? '').trim();
      const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
      if (!['status', 'embed', 'shutdown'].includes(action)) {
        socket.write(`${JSON.stringify({ ok: false, error: `Unsupported runner action: ${action}` })}\n`);
        socket.end();
        return;
      }

      scheduleIdleTimeout();
      lastUsedAt = timestamp();
      try {
        if (action === 'status') {
          const liveStatus = getEmbeddingServiceStatus();
          await refreshState();
          socket.write(`${JSON.stringify({
            ok: true,
            pid: process.pid,
            startedAt: liveStatus.startedAt ?? null,
            lastUsedAt,
            lastError,
            model: liveStatus.modelName ?? embedder.modelName,
            dimensions: liveStatus.dimensions ?? embedder.dimensions,
            socketPath: config.embedderRunnerSocketPath,
            requestTimeoutMs: config.embedderRunnerRequestTimeoutMs,
            idleTimeoutMs: config.embedderRunnerIdleTimeoutMs,
          })}\n`);
          socket.end();
          return;
        }

        if (action === 'shutdown') {
          socket.write(`${JSON.stringify({ ok: true, pid: process.pid, shuttingDown: true })}\n`);
          socket.end();
          await shutdown(payload.reason ?? 'remote shutdown');
          return;
        }

        const texts = Array.isArray(payload.texts) ? payload.texts.map((value) => String(value)) : null;
        if (!texts) {
          socket.write(`${JSON.stringify({ ok: false, error: 'Runner embed requests require a texts array.' })}\n`);
          socket.end();
          return;
        }

        const embeddings = await promiseWithTimeout(
          embedder.embedTexts(texts, { batchSize: Number(payload.batchSize ?? embedder.batchSize) }),
          config.embedderRunnerRequestTimeoutMs,
          `Embedder runner request timed out after ${config.embedderRunnerRequestTimeoutMs}ms.`,
        );
        await refreshState();
        socket.write(`${JSON.stringify({
          ok: true,
          pid: process.pid,
          model: embedder.modelName,
          dimensions: embeddings[0]?.length ?? embedder.dimensions,
          embeddings,
        })}\n`);
      } catch (error) {
        lastError = error.message;
        await refreshState();
        socket.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
      }
      socket.end();
    });
  });

  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.once('SIGHUP', () => {
    shutdown('SIGHUP');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.embedderRunnerSocketPath, async () => {
      server.off('error', reject);
      await fs.chmod(config.embedderRunnerSocketPath, 0o600).catch(() => {});
      resolve();
    });
  });

  await refreshState();
  scheduleIdleTimeout();
  await appendLog(buildLogPath(config), `Embedder runner ready | pid=${process.pid} | socket=${config.embedderRunnerSocketPath}`);
}

function promiseWithTimeout(promise, timeoutMs, message) {
  const normalizedTimeoutMs = Math.max(Number(timeoutMs ?? 1), 1);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, normalizedTimeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }).catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function buildRunnerStatusSummary(status) {
  return `mode=${status.mode} | state=${status.running ? 'running' : (status.stale ? 'stale' : 'stopped')} | backend=${status.backendIfQueriedNow} | pid=${status.pid ?? 'n/a'}${status.model ? ` | model=${status.model}` : ''}${status.dimensions ? ` | dimensions=${status.dimensions}` : ''}${status.lastError ? ` | error=${status.lastError}` : ''}`;
}

export function resolveRunnerConfigOverrides(config, overrides = {}) {
  return {
    ...config,
    ...overrides,
    embedderRunnerSocketPath: overrides.embedderRunnerSocketPath
      ? resolvePathFromBase(overrides.embedderRunnerSocketPath, process.cwd())
      : config.embedderRunnerSocketPath,
  };
}