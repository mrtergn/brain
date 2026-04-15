# Operator Guide

This is the fast operational manual for running Brain during daily development.

## Command Surface

| Goal | Command | Use it when |
| --- | --- | --- |
| Bootstrap the local embedding stack | `npm run brain:bootstrap:python` | Setting up a machine for the first time |
| Initialize runtime folders and launchers | `npm run brain:init` | First setup or after changing launcher-generation logic |
| Refresh canonical notes | `npm run brain:sync` | Repositories changed or the vault needs refresh |
| Validate the vault contract | `npm run brain:validate:vault` | You want an explicit drift check |
| Run the full readiness check | `npm run brain:doctor` | Before trusting retrieval or after deeper runtime changes |
| Rebuild embeddings | `npm run brain:embed` | Notes changed or retrieval feels stale |
| Inspect local retrieval | `npm run brain:query -- "auth bug solution"` | Debugging retrieval quality |
| Get guidance with research control | `npm run brain:consult -- "best practice for token refresh handling"` | Real coding, debugging, refactoring, or architecture work |
| Inspect resolved runtime paths and state | `npm run brain:status` | Confirm the active config and last successful operations |
| Start the MCP server | `npm run brain:mcp` | Using VS Code or Copilot against the local brain |
| Smoke-test the MCP server | `npm run brain:mcp:healthcheck` | Verifying tool exposure without holding an MCP session open |
| Validate the sandbox vault path | `npm run brain:sync:self-test` | Checking the canonical writer against `obsidian-sync/` |

## Standard Workflows

### Daily refresh

Run this when sibling repositories changed or when you want a clean start before important work:

```bash
npm run brain:sync
npm run brain:validate:vault
npm run brain:doctor
npm run brain:embed
```

This refresh cycle updates both implementation memory and documentation-style memory. If strong repo-facing surfaces changed in sibling repositories, the next sync can refresh reusable documentation patterns as well.

### First working session on a machine

```bash
npm run brain:bootstrap:python
npm run brain:init
npm run brain:sync
npm run brain:validate:vault
npm run brain:doctor
npm run brain:embed
```

### Target a specific project

When you want to narrow work to one or more projects, use `--project`:

```bash
npm run brain:sync -- --project brain
npm run brain:embed -- --project brain --force
npm run brain:consult -- --project brain "safe extension point for MCP changes"
```

### Work with VS Code and Copilot

1. Ensure your user MCP config points at the generated runner or the Node entrypoint.
2. Run `npm run brain:mcp:healthcheck` and confirm the full `brain.*` tool set is exposed.
3. In VS Code, confirm `local-brain` appears in `MCP: List Servers` and is trusted.
4. For non-trivial tasks, let the agent call `brain.consult` first.
5. Use `brain.query` only when you are investigating why retrieval quality is weak.

## Health Checklist

The system is healthy when all of the following are true:

- `npm run brain:status` shows the expected paths and non-null `Last sync` and `Last embed` values.
- `npm run brain:status` also shows usage-event, tracked-result, and promotion-candidate counts for the local admission loop, a derived `Last learn` timestamp, and the latest embedder prewarm summary.
- `npm run brain:runner:status` reports either a clean stopped state or a running PID/model pair, never an unexplained zombie helper.
- `npm run brain:validate:vault` passes with no unexpected project notes, knowledge mirrors, marker sections, or runtime artifacts.
- `npm run brain:doctor` passes and reports MCP as healthy.
- `npm run brain:query -- "reusable pattern"` returns canonical note surfaces rather than deprecated ones, and the top result includes both matched and trusted reasons.
- `npm run brain:doctor` reports usable retrieval diagnostics such as current-project recall, citation coverage, a dedicated embedder-prewarm line, warmed retrieval latency, and usage-backed admission counters instead of only generic smoke success.
- A second fresh `brain:query` or `brain:consult` run is materially faster after the runner is already up, because the one-shot CLI process reused the persistent local embedder instead of reloading the model again.
- documentation-oriented retrieval returns strong README, architecture, operator-guide, or agent-instruction surfaces instead of generic markdown matches.
- `npm run brain:consult -- "best practice for token refresh handling"` recommends web research for that current auth best-practice query, prints a local trust basis, and shows the decision score that triggered escalation.
- `npm run brain:mcp:healthcheck` returns quickly and does not leave an idle MCP, embedder, or Chroma helper process behind.

## Managed Embedder Prewarm

Brain now treats embedder cold-start as a managed runtime concern instead of letting the first real request discover it implicitly.

- The default `auto` mode blocks during `brain:mcp` startup and `brain:doctor` so those long-lived or multi-step paths expose model-load cost once.
- The same `auto` mode starts background prewarm during `brain:embed`, `brain:query`, and `brain:consult`, which overlaps startup with other work but still leaves one-shot cold commands paying most of the model-load wall time.
- `brain:status` and `brain:mcp:healthcheck` skip prewarm so they stay cheap and non-persistent.
- On the current validation machine, embedder prewarm settled at about `6.5s`, post-prewarm query smoke at about `615ms`, and warmed retrieval diagnostics at about `20ms`.
- Override behavior with `--embedder-prewarm` or `BRAIN_EMBEDDER_PREWARM` using `auto`, `blocking`, `background`, or `off`.
- Tune the startup budget with `--embedder-prewarm-timeout-ms` or `BRAIN_EMBEDDER_PREWARM_TIMEOUT_MS`.
- Prewarm summaries are runtime-only. They do not add query-history entries, promotion candidates, or vault notes.

## Persistent CLI Embedder Runner

Brain now also exposes an explicitly owned persistent local embedder runner for one-shot CLI use.

- `npm run brain:runner:start` starts the runner and waits until it is healthy.
- `npm run brain:runner:status` reports whether the runner is stopped, stale, or running, along with the PID and model details when available.
- `npm run brain:runner:restart` rotates the runner cleanly if you need to reset ownership or recover from a bad state.
- `npm run brain:runner:stop` stops the runner and its owned embedder child without touching the MCP-owned helpers.
- In the default `auto` mode, `brain:query` and `brain:consult` will start the runner on demand and later fresh CLI processes will reuse it.
- In `require` mode, `brain:query`, `brain:consult`, and runner-aware diagnostics fail clearly instead of silently falling back to the in-process embedder.
- `brain:doctor` reports the runner state and uses it only when it is already healthy or required. Otherwise it keeps the conservative in-process path.
- Override runner behavior with `--embedder-runner-mode`, `--embedder-runner-startup-timeout-ms`, `--embedder-runner-request-timeout-ms`, `--embedder-runner-idle-timeout-ms`, `--embedder-runner-socket-path`, or the matching `BRAIN_EMBEDDER_RUNNER_*` environment variables.
- Runner state is operational only. It does not create query-history rows, usage-backed admission events, or vault notes.

## What Doctor Actually Checks

`brain:doctor` goes beyond markdown structure. It checks:

- vault validity through the canonical vault contract
- knowledge-model version mismatches in embedded project state
- deprecated retrieval surfaces that still exist in chunk cache
- missing embeddings and empty indexed-project state
- managed embedder prewarm readiness and timeout/failure reporting before warm retrieval smoke runs
- query smoke results for a realistic retrieval prompt
- consultation behavior for a current auth best-practice prompt, including decision score and escalation trace
- project-level retrieval diagnostics derived from real indexed project signals
- current-project precision, citation coverage, strong-evidence rate, and retrieval latency
- local usage-backed admission counters so repeated useful snapshot hits can be reviewed before write-back
- provenance-aware trust fields on query results and consult responses
- MCP health and the presence of the expected `brain.*` tools

If `doctor` fails, treat it as a runtime readiness problem, not just a documentation problem.

## Recovery Playbooks

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| `status` shows no indexed projects | Sync and embed have not run yet | Run `npm run brain:sync` then `npm run brain:embed` |
| `validate:vault` reports unexpected project files | Deprecated notes or runtime files leaked into the vault | Remove the offending files or rerun `npm run brain:sync`, then validate again |
| `doctor` reports deprecated retrieval surfaces | Old chunk data still references removed note models | Run `npm run brain:sync` then `npm run brain:embed -- --force` |
| The first cold `query` or `consult` is much slower than later ones | The Python embedder is still loading the sentence-transformer model | Prefer the long-lived `npm run brain:mcp` flow for daily agent work, or let `brain:doctor` pay the blocking prewarm first |
| `brain:runner:status` shows `stale` | A previous runner left a dead PID, missing socket, or orphaned lock | Run `npm run brain:runner:stop`, then `npm run brain:runner:start`; if it persists, inspect `data/logs/brain-embedder-runner.stderr.log` |
| `status` shows the latest embedder prewarm as failed or timed out | Python runtime drift, missing packages, or the model load exceeded the timeout budget | Run `npm run brain:doctor`, inspect `data/logs/brain.log` or `data/logs/brain-mcp.log`, rerun `npm run brain:bootstrap:python`, and increase `--embedder-prewarm-timeout-ms` only if the environment is otherwise healthy |
| MCP healthcheck fails or tools are missing | MCP entrypoint or launcher drifted | Run `npm run brain:init`, then `npm run brain:mcp:healthcheck`, and inspect `data/logs/brain-mcp.log` |
| An MCP session looks stale after a terminal closes | A detached `brain:mcp` process or helper child is still running | Run `pkill -TERM -f 'apps/mcp-server/index.mjs'`, then `pkill -TERM -f 'scripts/python/embedder.py --server'`, then `pkill -TERM -f 'scripts/python/chroma_sidecar.py --server'`, and restart `npm run brain:mcp` |
| Copilot ignores local context | MCP server is not registered, not trusted, or retrieval is stale | Verify user MCP config, trust `local-brain`, rerun `sync`, `doctor`, and `embed` |
| Retrieval feels weak or generic | Notes are stale, prompt is vague, or embeddings lag behind vault content | Run `sync` and `embed`, then query with a concrete symptom, subsystem, and repo name |

## Vault Contract in Daily Use

The writable note model is intentionally small:

- `01_Projects/<ProjectName>/overview.md`
- `01_Projects/<ProjectName>/architecture.md`
- `01_Projects/<ProjectName>/learnings.md`
- `01_Projects/<ProjectName>/prompts.md`
- `03_Agent_Notes/query-history.md`
- `03_Agent_Notes/debugging-insights.md`
- `03_Agent_Notes/agent-workflow-notes.md`
- `03_Agent_Notes/research-candidates.md` only when you intentionally capture provisional external findings
- `04_Knowledge_Base/reusable-patterns.md`
- `04_Knowledge_Base/documentation-style-patterns.md`
- `99_System/*.md`

Per-project `logs.md` and per-project knowledge mirrors are deprecated. They are not alternate valid models.

## Query, Consult, and Capture Discipline

- Use `brain:consult` for real work. It adds mode selection, confidence scoring, source priorities, and memory guidance.
- Use `brain:query` for retrieval debugging. It answers, “What did the local index match?” rather than, “What should I do next?” When you provide `--project`, the runtime now uses that current-project context during reranking instead of treating the search as a fully global lookup.
- `brain:consult` now exposes a decision score and escalation drivers. If it escalates, read those drivers before fetching external guidance.
- If `brain:query` returns weak trust signals or thin supporting evidence, treat that as a cue to improve the prompt, refresh memory, or escalate through `brain:consult` instead of forcing a local-only answer.
- For README, architecture-doc, operator-doc, or agent-instruction work, start with local documentation patterns before inventing new structure.
- For repo-shaped implementation work, prefer prompts that name the boundary at risk and the validation surface you expect to use. The strengthened note model now surfaces both directly when the repo exposes them.
- Managed embedder prewarm is operational state only. It never creates query-history rows, admission usage events, or vault content.
- Use `brain.capture_learning` only for proven, reusable outcomes.
- Use `brain.capture_research_candidate` only for promising findings that are not yet proven enough for durable memory.
- Remember that `research-candidates.md` is not part of the semantic core by default.

## Useful Runtime Paths

| Path | Purpose |
| --- | --- |
| `data/cache/projects/` | Cached normalized project snapshots |
| `data/cache/chunks/` | Chunk cache used for embeddings and retrieval |
| `data/chroma/` | Local vector store |
| `data/logs/` | Runtime and MCP logs |
| `data/state/` | Last scan, sync, embed, and query history state |
| `data/runtime/` | Generated launchers such as `run-brain.sh` and `run-brain-mcp.sh` |

## Safe Operating Habits

- Re-run `brain:init` after changing runtime launcher generation or MCP integration.
- Re-run `brain:validate:vault` after changing note writing, cleanup rules, or the vault contract.
- Re-run `brain:doctor` after integrated changes that affect retrieval, consultation, or MCP readiness.
- Prefer concrete queries that name the repo, subsystem, and failure mode.
- Keep external findings provisional until implementation proves they should become memory.