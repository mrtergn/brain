# Super Brain Rollout Plan

## Goal

Extend the existing Brain architecture into a stronger agent-native runtime without breaking current vault, runtime-state, or MCP contracts.

## Existing extension points confirmed

- `packages/brain-service/index.mjs`
  - `gatherLocalBrainContext()` is the main context assembly seam.
  - `consultBrain()` and `searchBrain()` already expose trust-aware retrieval and memory-admission hooks.
- `packages/retriever/index.mjs`
  - Ranking already uses intent, confidence, evidence quality, support count, and project-awareness.
- `packages/provenance/index.mjs`
  - Shared evidence model already exists and should remain the canonical trust layer.
- `packages/state-manager/index.mjs`
  - Runtime state already tracks query history, operations, failures, and memory-admission candidates under `data/state/`.
- `packages/chunker/index.mjs`
  - Chunk metadata flow already persists evidence/trust metadata into retrieval.
- `packages/normalizer/index.mjs`
  - Normalized project snapshots already expose workflows, boundaries, integration surfaces, prompts, documentation patterns, and project provenance.
- `packages/obsidian-writer/canonical-writer.mjs`
  - Canonical writer is the only allowed writer and can surface selective human-readable outputs.
- `apps/mcp-server/index.mjs`
  - Stable additive MCP schemas can expose new fields/tools without breaking clients.
- `apps/worker/index.mjs`
  - Sync/embed/doctor flows already own cache refresh, embedding, diagnostics, and readiness checks.

## Non-negotiable constraints

- Keep runtime state under `data/`.
- Do not add a second active writer.
- Do not move operational/session artifacts into the vault.
- Prefer additive MCP schema/tool expansion over breaking payload changes.
- Extend current retrieval and state pipelines instead of replacing them.

## Shared domain model additions

Introduce runtime-native records in `data/state/` and cache files:

1. `contextAssemblies`
   - per query/task assembled context envelope
   - includes selected projects, top evidence, validation surfaces, note refs, dynamic signals, and provenance summary

2. `episodes`
   - per task/session episodic records
   - fields: id, query/task, project scope, actions, outcomes, failures, learnings, timestamps, source traces

3. `distillationCandidates`
   - stronger successor to current promotion candidates
   - supports project learning, reusable pattern, prompt pattern, decision journal, and workspace summary targets

4. `knowledgeFreshness`
   - tracks fingerprints and stale reasons for project snapshots, chunk caches, global knowledge, and derived records

5. `decisionJournal`
   - runtime-level ADR-style records derived from proven project decisions and captured operator decisions

6. `agentWorkspaces`
   - shared multi-agent task workspace records with hypotheses, findings, handoffs, and status

7. `promptPatterns`
   - stores reusable prompt/query shapes, scope, success signals, and linked evidence

8. `preflightReports`
   - simulation output for likely impact, validation paths, stale knowledge warnings, and relevant episodes/patterns

9. `projectGraph`
   - local derived graph artifact built from normalized snapshots, entry points, dependencies, boundaries, and note links

## Module placement

### New packages

- `packages/context-assembler/`
  - build a first-class assembled context object on top of retrieval + project summary + recent learnings + patterns + freshness
- `packages/episodic-memory/`
  - create/update/query episode records and workspace records
- `packages/knowledge-distiller/`
  - turn episodes, repeated retrieval hits, and captured learnings into distillation candidates and write-back proposals
- `packages/freshness/`
  - compute staleness and invalidation across snapshots, chunks, notes, and derived artifacts
- `packages/project-graph/`
  - derive a local cross-project graph from normalized project snapshots and cache it under `data/cache/`
- `packages/preflight/`
  - build preflight reports from graph, freshness, context assembly, and episodic memory

### Extend existing packages

- `packages/state-manager/`
  - add normalized state support for the new runtime records
- `packages/brain-service/`
  - route all new user-facing behavior through current service entrypoints
- `packages/retriever/`
  - add repo mode and freshness/episode-aware boosts, not a new retrieval engine
- `packages/obsidian-writer/`
  - surface selective summaries only for durable, human-readable outputs
- `apps/mcp-server/`
  - expose additive tools/fields for assembled context, workspace, preflight, and richer provenance
- `apps/worker/`
  - recalculate graph/freshness artifacts during sync/embed/doctor

## Phasing

### V1

Ship the smallest additive layer that makes Brain feel more agent-native.

Scope:

- First-class live context assembler
- Episodic memory store/query
- Automatic post-task distillation candidate generation
- Additive provenance/confidence/context fields in service + MCP payloads

Implementation notes:

- Extend `gatherLocalBrainContext()` to delegate to a reusable context assembler.
- Persist assembled context and episodes in runtime state only.
- Reuse current memory-admission candidate logic as the seed for distillation candidates.
- Add MCP tool(s) for assembled context and episode recall only if current payloads become too overloaded.

QA scenarios:

- Tool: `npm run brain:test`
  - Step: add unit coverage for context assembly, episode persistence, and distillation candidate generation.
  - Expected result: tests pass and assert that assembled context includes provenance-bearing evidence, note references, and validation surfaces; episodes persist under runtime state; distillation candidates are generated without vault writes.
- Tool: `npm run brain:doctor`
  - Step: run doctor after V1 wiring lands.
  - Expected result: doctor remains healthy and reports retrieval/consult readiness with no regression in trust-aware fields.
- Tool: `npm run brain:mcp:healthcheck`
  - Step: verify MCP after schema/tool additions.
  - Expected result: expected `brain.*` tools remain exposed; additive V1 fields do not break healthcheck.
- Tool: `npm run brain:consult -- --project brain "safe extension point for MCP changes"`
  - Step: inspect a real consult response.
  - Expected result: consult returns assembled context/provenance-rich output and can reference relevant recent episodes or distillation guidance when present.

### V2

Make derived memory trustworthy and durable.

Scope:

- Change-aware invalidation / freshness engine
- Decision journal records
- Smarter distillation targeting learnings, reusable patterns, prompt patterns, and decision entries
- Repo-aware retrieval modes using freshness and episode signals

Implementation notes:

- Use snapshot/chunk/global-note fingerprints already present in worker/embed flows.
- Treat stale derived artifacts as degraded trust, not hard errors.
- Add selective writer support for decision summaries only if they map to canonical notes or stable global notes.

QA scenarios:

- Tool: `npm run brain:test`
  - Step: add tests for freshness invalidation, decision journal records, and repo-aware retrieval boosts/degradation.
  - Expected result: stale fingerprints mark derived records as degraded, not deleted; decision records persist under runtime state; retrieval ranking changes when freshness/episode signals differ.
- Tool: `npm run brain:sync && npm run brain:embed`
  - Step: change a source note or snapshot input, then resync/re-embed.
  - Expected result: freshness state updates, stale reasons are recorded, affected caches/fingerprints refresh, and trust output reflects the new freshness status.
- Tool: `npm run brain:status`
  - Step: inspect runtime state after V2 changes.
  - Expected result: status can surface freshness/degradation state and any new decision/distillation counts without moving operational data into the vault.
- Tool: `npm run brain:validate:vault`
  - Step: validate the vault after decision-summary write paths are added.
  - Expected result: canonical vault contract still passes and no runtime artifacts leak into project/global notes.

### V3

Add coordination and simulation layers on top of the stable memory core.

Scope:

- Cross-repo local project graph
- Multi-agent shared workspace
- Prompt/pattern memory
- Preflight simulation

Implementation notes:

- Build graph from normalized snapshots and cached artifacts first; do not introduce external graph infrastructure.
- Workspace records stay operational under `data/state/`; only durable conclusions are distilled into canonical notes.
- Preflight consumes graph + freshness + context + episodes and returns likely impact plus validation guidance.

QA scenarios:

- Tool: `npm run brain:test`
  - Step: add tests for graph derivation, shared workspace lifecycle, prompt-pattern capture, and preflight simulation.
  - Expected result: local graph edges derive from normalized snapshots; workspace state supports findings/handoffs; prompt patterns are ranked from proven usage; preflight returns impact, freshness, and validation guidance.
- Tool: `npm run brain:doctor`
  - Step: run doctor with graph/preflight readiness checks added.
  - Expected result: doctor reports graph/preflight readiness and fails clearly if graph artifacts are missing or stale.
- Tool: `npm run brain:mcp:healthcheck`
  - Step: verify MCP after V3 tool additions.
  - Expected result: any new graph/workspace/preflight tools are exposed and existing tools remain stable.
- Tool: MCP or CLI preflight invocation
  - Step: run a real preflight against `brain` for a non-trivial change target.
  - Expected result: output includes likely affected surfaces, freshness warnings, related episodes/patterns, and recommended validation commands.

## Sequencing constraints

1. State normalization must land before any feature writes new runtime records.
2. Context assembler should land before MCP/schema growth so all surfaces share one context source.
3. Distillation should build on episodes instead of a separate parallel event model.
4. Freshness must precede graph-driven/preflight trust decisions.
5. Graph should precede preflight simulation.

## Main risks

- Overloading MCP schemas instead of introducing clean additive tools.
- Writing operational agent workspace artifacts into the vault.
- Duplicating provenance/confidence logic outside `packages/provenance`.
- Building a graph abstraction disconnected from existing normalized snapshots.
- Letting distillation auto-promote weak findings into canonical notes.

## Success criteria

- All new capabilities are additive to current CLI/MCP contracts.
- `brain:doctor` can validate freshness/context/graph/preflight readiness.
- Runtime state remains under `data/`.
- Vault contract remains canonical and small.
- Retrieval and consult can explain not only what matched, but what context was assembled, what prior episodes matter, and whether the memory is fresh enough to trust.
