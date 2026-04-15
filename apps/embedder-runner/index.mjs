#!/usr/bin/env node

import { appendLog, buildLogPath, buildRuntimeConfig, parseArgs } from '../../packages/shared/index.mjs';
import { runEmbedderRunnerServer } from '../../packages/embedder-runner/index.mjs';

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = buildRuntimeConfig({
    configPath: args.config,
    dataRoot: args['data-root'],
    logRoot: args['log-root'],
    statePath: args['state-path'],
    pythonExecutable: args.python,
    embedderRunnerMode: args['embedder-runner-mode'],
    embedderRunnerSocketPath: args['embedder-runner-socket-path'],
    embedderRunnerStartupTimeoutMs: args['embedder-runner-startup-timeout-ms'],
    embedderRunnerRequestTimeoutMs: args['embedder-runner-request-timeout-ms'],
    embedderRunnerIdleTimeoutMs: args['embedder-runner-idle-timeout-ms'],
  });

  await appendLog(buildLogPath(config), `Launching embedder runner entrypoint | socket=${config.embedderRunnerSocketPath}`);
  await runEmbedderRunnerServer(config);
}

if (process.argv[1] && process.argv[1].endsWith('index.mjs')) {
  main().catch(async (error) => {
    const config = buildRuntimeConfig();
    await appendLog(buildLogPath(config), `Embedder runner failed: ${error.message}`);
    console.error(error.message);
    process.exitCode = 1;
  });
}