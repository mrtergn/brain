import http from 'node:http';

import { parseArgs } from '../../packages/shared/index.mjs';
import { runQuery, runStatus, runSync } from '../worker/index.mjs';

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const port = Number(args.port ?? 4646);
  const baseOptions = {
    configPath: args.config,
    projectsRoot: args['projects-root'],
    vaultRoot: args['vault-root'],
    dataRoot: args['data-root'],
    cacheRoot: args['cache-root'],
    chromaRoot: args['chroma-root'],
    logRoot: args['log-root'],
    statePath: args['state-path'],
    pythonExecutable: args.python,
  };
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/status') {
        const payload = await runStatus(baseOptions);
        respondJson(response, 200, {
          ok: true,
          status: {
            lastScanAt: payload.state.lastScanAt,
            lastSyncAt: payload.state.lastSyncAt,
            lastEmbedAt: payload.state.lastEmbedAt,
            lastLearnAt: payload.state.lastLearnAt,
            vectorStatus: payload.vectorStatus,
          },
        });
        return;
      }

      if (request.method === 'POST' && request.url === '/query') {
        const body = await readJsonBody(request);
        const payload = await runQuery({ ...baseOptions, queryText: body.query, topK: body.topK });
        respondJson(response, 200, {
          ok: true,
          results: payload.retrievalResponse.results,
          reasoning: payload.reasoning,
        });
        return;
      }

      if (request.method === 'POST' && request.url === '/sync') {
        const body = await readJsonBody(request);
        const payload = await runSync({ ...baseOptions, projectNames: body.projects ?? [] });
        respondJson(response, 200, {
          ok: true,
          syncSummary: payload.syncSummary,
        });
        return;
      }

      respondJson(response, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      respondJson(response, 500, { ok: false, error: error.message });
    }
  });

  server.listen(port, () => {
    console.log(`Brain API listening on http://127.0.0.1:${port}`);
  });
}

function respondJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

if (process.argv[1] && process.argv[1].endsWith('index.mjs')) {
  main();
}