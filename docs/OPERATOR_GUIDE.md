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
- `npm run brain:validate:vault` passes with no unexpected project notes, knowledge mirrors, marker sections, or runtime artifacts.
- `npm run brain:doctor` passes and reports MCP as healthy.
- `npm run brain:query -- "reusable pattern"` returns canonical note surfaces rather than deprecated ones.
- documentation-oriented retrieval returns strong README, architecture, operator-guide, or agent-instruction surfaces instead of generic markdown matches.
- `npm run brain:consult -- "best practice for token refresh handling"` recommends web research for that current auth best-practice query.

## What Doctor Actually Checks

`brain:doctor` goes beyond markdown structure. It checks:

- vault validity through the canonical vault contract
- knowledge-model version mismatches in embedded project state
- deprecated retrieval surfaces that still exist in chunk cache
- missing embeddings and empty indexed-project state
- query smoke results for a realistic retrieval prompt
- consultation behavior for a current auth best-practice prompt
- MCP health and the presence of the expected `brain.*` tools

If `doctor` fails, treat it as a runtime readiness problem, not just a documentation problem.

## Recovery Playbooks

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| `status` shows no indexed projects | Sync and embed have not run yet | Run `npm run brain:sync` then `npm run brain:embed` |
| `validate:vault` reports unexpected project files | Deprecated notes or runtime files leaked into the vault | Remove the offending files or rerun `npm run brain:sync`, then validate again |
| `doctor` reports deprecated retrieval surfaces | Old chunk data still references removed note models | Run `npm run brain:sync` then `npm run brain:embed -- --force` |
| MCP healthcheck fails or tools are missing | MCP entrypoint or launcher drifted | Run `npm run brain:init`, then `npm run brain:mcp:healthcheck`, and inspect `data/logs/brain-mcp.log` |
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
- Use `brain:query` for retrieval debugging. It answers, “What did the local index match?” rather than, “What should I do next?”
- For README, architecture-doc, operator-doc, or agent-instruction work, start with local documentation patterns before inventing new structure.
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