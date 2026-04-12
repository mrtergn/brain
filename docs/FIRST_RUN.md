# First Run

This guide gets a new machine from zero to a working local Brain runtime with canonical notes, embeddings, and MCP readiness.

## Prerequisites

- Node.js 18 or newer
- Python 3 available as `python3`
- A local filesystem layout where this repository sits next to the repositories you want Brain to scan
- Optional live Obsidian vault; if none is found, Brain falls back to `./obsidian-sync`

## Default Path Behavior

| Setting | Default |
| --- | --- |
| Projects root | Parent directory of this repository |
| Vault root | `~/Obsidian/Brain` when present, otherwise `./obsidian-sync` |
| Data root | `./data` |

Defaults are usually enough when Brain is installed alongside the repositories it should index.

## 1. Optional Local Config

If you need non-default paths, create a local config file before running the runtime:

```bash
cp brain.config.example.json brain.config.json
```

Then edit `brain.config.json` with your local paths. Configuration precedence is CLI flags, then environment variables, then `brain.config.json`, then safe defaults.

## 2. Bootstrap Python

```bash
npm run brain:bootstrap:python
```

This creates `.venv` and installs the local embedding stack used by the Chroma sidecar and sentence-transformer pipeline.

## 3. Initialize the Runtime

```bash
npm run brain:init
```

`brain:init` does three important things:

- creates runtime directories under `data/`
- bootstraps the canonical vault structure when needed
- generates local launchers under `data/runtime/`, including `run-brain.sh`, `run-brain-mcp.sh`, and `com.local.ai-brain.plist`

## 4. Build the Initial Memory

```bash
npm run brain:sync
npm run brain:validate:vault
npm run brain:doctor
npm run brain:embed
```

Why this order matters:

- `brain:sync` refreshes canonical project notes and managed global notes.
- `brain:sync` can also refresh cross-project documentation-style patterns when it detects strong repo-facing surfaces in indexed repositories.
- `brain:validate:vault` confirms the vault does not contain deprecated note types or runtime artifacts.
- `brain:doctor` checks the runtime, smoke-tests retrieval and consultation behavior, and verifies MCP health.
- `brain:embed` builds the semantic index from the canonical note set.

## 5. Verify the Result

Run a retrieval check, a status check, and an MCP smoke test:

```bash
npm run brain:query -- "auth bug solution"
npm run brain:status
npm run brain:mcp:healthcheck
```

Success looks like this:

- `brain:query` returns canonical note surfaces
- `brain:status` shows the resolved paths you expect and a non-null `Last embed`
- `brain:mcp:healthcheck` lists the full `brain.*` tool set
- managed knowledge notes can include both reusable implementation patterns and reusable documentation-style patterns after sync

## 6. Connect VS Code

1. Register the `local-brain` MCP server in your user MCP config.
2. Point it at either the generated runner under `data/runtime/run-brain-mcp.sh` or the Node entrypoint at `apps/mcp-server/index.mjs`.
3. In VS Code, run `MCP: List Servers` and confirm `local-brain` is enabled and trusted.
4. Keep [MCP_INTEGRATION.md](MCP_INTEGRATION.md) nearby if you need the detailed integration contract.

## 7. First Useful Commands

Use one query to inspect retrieval and one consultation to exercise the research decision layer:

```bash
npm run brain:query -- "auth bug solution"
npm run brain:consult -- "best practice for token refresh handling"
```

`brain:query` tells you what local context matched. `brain:consult` tells you whether Brain believes that local context is enough or whether authoritative web validation is warranted.

## Minimal Daily Refresh After Setup

```bash
npm run brain:sync
npm run brain:validate:vault
npm run brain:doctor
npm run brain:embed
```

Watch mode is optional. The core product story does not depend on it.

## If Setup Fails

- If `validate:vault` fails, remove the deprecated note files or runtime artifacts it names, then run `brain:sync` again.
- If `doctor` fails on MCP health, rerun `brain:init`, then check `data/logs/brain-mcp.log`.
- If retrieval returns nothing useful, make sure `brain:embed` completed and that the vault contains canonical notes for at least one indexed project.
- If you want to validate the canonical writer against the sandbox vault instead of a live vault, run `npm run brain:sync:self-test`.