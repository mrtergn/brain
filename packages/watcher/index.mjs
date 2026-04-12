import fsNative from 'node:fs';
import path from 'node:path';

import { shouldIgnoreSourcePath } from '../shared/index.mjs';

export async function startWatchLoop(config, onProjectsChanged) {
  if (config.watchMode === 'poll') {
    return startPollingLoop(config, onProjectsChanged);
  }

  try {
    return await startNativeLoop(config, onProjectsChanged);
  } catch (error) {
    if (config.watchMode === 'native') {
      throw error;
    }
    return startPollingLoop(config, onProjectsChanged);
  }
}

async function startNativeLoop(config, onProjectsChanged) {
  const pendingProjects = new Set();
  let debounceTimer = null;
  let isRunning = false;

  const flush = async () => {
    if (isRunning || pendingProjects.size === 0) {
      return;
    }
    isRunning = true;
    const projectNames = [...pendingProjects];
    pendingProjects.clear();
    try {
      await onProjectsChanged(projectNames, 'native-watch');
    } finally {
      isRunning = false;
    }
  };

  const scheduleFlush = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      void flush();
    }, 1500);
  };

  const watcher = fsNative.watch(config.projectsRoot, { recursive: true }, (_eventType, fileName) => {
    if (!fileName) {
      return;
    }
    const relativePath = String(fileName).split(path.sep).join('/');
    if (!relativePath || shouldIgnoreSourcePath(relativePath)) {
      return;
    }
    const projectName = relativePath.split('/')[0];
    if (!projectName || (!config.includeBrain && projectName === 'brain')) {
      return;
    }
    pendingProjects.add(projectName);
    scheduleFlush();
  });

  console.log(`Watching ${config.projectsRoot} in native mode`);
  await waitUntilInterrupted(async () => {
    watcher.close();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
  });
}

async function startPollingLoop(config, onProjectsChanged) {
  let isRunning = false;
  console.log(`Watching ${config.projectsRoot} in polling mode every ${config.pollIntervalMs / 1000}s`);
  const intervalId = setInterval(() => {
    if (isRunning) {
      return;
    }
    isRunning = true;
    void onProjectsChanged(config.projectNames, 'poll-watch').finally(() => {
      isRunning = false;
    });
  }, config.pollIntervalMs);

  await waitUntilInterrupted(async () => {
    clearInterval(intervalId);
  });
}

async function waitUntilInterrupted(onExit) {
  await new Promise((resolve, reject) => {
    let closed = false;
    const close = async () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await onExit();
        resolve();
      } catch (error) {
        reject(error);
      }
    };

    process.on('SIGINT', () => {
      void close();
    });
    process.on('SIGTERM', () => {
      void close();
    });
  });
}