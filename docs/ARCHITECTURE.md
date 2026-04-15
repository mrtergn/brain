# Architecture

Brain is a local-first developer memory runtime. It reads sibling repositories as source input, writes canonical knowledge notes into an Obsidian vault, embeds that note model locally, and serves the same memory to operators and agents through CLI and MCP surfaces.

## Architectural Intent

| Concern | Design response |
| --- | --- |
| Durable repo memory | Generate a narrow, canonical note model instead of free-form repository dumps |
| Retrieval quality | Combine local embeddings, note-aware retrieval, and lightweight reasoning |
| Trustworthy memory | Preserve evidence provenance from analysis through retrieval, consultation, and selective write-back |
| Agent usability | Expose a stable `brain.*` tool contract through MCP |
| Research control | Decide explicitly between `local-only`, `local-plus-web-assist`, and `web-first-local-adaptation` |
| Documentation quality | Learn reusable repo-facing documentation patterns from real repository surfaces |
| Drift prevention | Enforce the vault contract and fail fast on deprecated note surfaces |

Everything else in the repository exists to support those outcomes.

## System Boundaries

| Area | Writable | Role | Must not become |
| --- | --- | --- | --- |
| Sibling repositories under the configured projects root | No | Read-only source input for project analysis | A write target or automation playground |
| Configured Obsidian vault | Yes | Human-readable knowledge output | Runtime state, logs, caches, or launchers |
| `data/` | Yes | Local runtime state, cache, logs, generated launchers, and Chroma storage | Canonical documentation or durable project notes |
| `obsidian-sync/` | Yes | Sandbox validation vault for self-test and local verification | The assumed live vault in production use |
| Brain source tree | Yes | Runtime and documentation code | A mirror of the vault or the vector store |

## Runtime Topology

```mermaid
flowchart LR
	subgraph Inputs["Source inputs"]
		repos["Sibling repositories"]
	end

	subgraph Entry["Operator surfaces"]
		cli["apps/cli"]
		mcp["apps/mcp-server"]
	end

	subgraph Core["Core runtime"]
		worker["apps/worker"]
		scan["scanner, parser, normalizer"]
		writer["obsidian-writer/canonical-writer"]
		service["brain-service"]
		consult["reasoner and research"]
		contract["vault-contract"]
	end

	subgraph State["Managed state"]
		vault["Configured Obsidian vault"]
		chroma["Chroma vector store"]
		runtime["data/ cache, logs, state, launchers"]
	end

	repos --> scan
	cli --> worker
	worker --> scan
	worker --> writer
	writer --> contract
	contract --> vault
	worker --> chroma
	worker --> runtime
	mcp --> service
	service --> chroma
	service --> vault
	service --> consult
```

## Authoritative Files

| Path | Authority |
| --- | --- |
| `apps/cli/index.mjs` | Canonical operator command surface for `init`, `scan`, `sync`, `embed`, `query`, `consult`, `validate-vault`, `doctor`, `learn`, `watch`, and `status` |
| `apps/worker/index.mjs` | Main orchestration layer behind CLI operations |
| `apps/mcp-server/index.mjs` | Sole MCP entrypoint and stable registration surface for `local-brain` |
| `packages/brain-service/index.mjs` | Search, consultation, synthesis, project summary, related patterns, recent learnings, and write-back tools |
| `packages/research/index.mjs` | Consultation mode selection, source prioritization, and memory-level guidance |
| `packages/provenance/index.mjs` | Shared evidence model, trust scoring, source normalization, and metadata parsing |
| `packages/obsidian-writer/canonical-writer.mjs` | Only active note writer and vault bootstrap path |
| `packages/vault-contract/index.mjs` | Canonical note paths, cleanup rules, and validation logic |
| `packages/vector-store/index.mjs` | Local Chroma integration with a shared in-process Python sidecar for repeated queries |
| `packages/state-manager/index.mjs` | Runtime state, query-history persistence, and local usage-backed memory-admission tracking |

## Canonical Vault Contract

### Project notes

Each project folder under `01_Projects/<ProjectName>/` is allowed exactly four managed notes:

| File | Purpose |
| --- | --- |
| `overview.md` | Project purpose, stack, boundaries, and change guidance |
| `architecture.md` | Runtime structure, interfaces, and extension points |
| `learnings.md` | Durable, implementation-backed lessons |
| `prompts.md` | Retrieval and agent prompt scaffolding for safe work |

### Global notes

| Path | Purpose |
| --- | --- |
| `01_Projects/_Project_Index.md` | Project index across the vault |
| `03_Agent_Notes/query-history.md` | Query and consultation history written from runtime state |
| `03_Agent_Notes/debugging-insights.md` | Durable debugging guidance |
| `03_Agent_Notes/agent-workflow-notes.md` | Operator and agent workflow notes |
| `03_Agent_Notes/research-candidates.md` | Optional holding area for promising but unproven external findings |
| `04_Knowledge_Base/reusable-patterns.md` | Cross-project reusable engineering patterns |
| `04_Knowledge_Base/documentation-style-patterns.md` | Cross-project reusable repository presentation and documentation patterns |
| `06_Summaries/Portfolio_Summary.md` | High-level summary surface |
| `99_System/AI_Brain_Architecture.md` | System architecture note written into the vault |
| `99_System/Operations.md` | Operational guidance note written into the vault |
| `99_System/Retrieval.md` | Retrieval guidance note written into the vault |

### Deprecated surfaces the runtime actively rejects

- per-project `logs.md`
- per-project knowledge mirrors such as `04_Knowledge_Base/<ProjectName>.md`
- legacy generated markers such as `<!-- AI_BRAIN:GENERATED_START -->`
- runtime artifacts inside the vault, including launchers, state files, Chroma files, or runtime directories

`research-candidates.md` is intentionally optional and intentionally excluded from the semantic core. It exists to keep web-assisted work controlled without promoting raw external summaries into durable memory.

## Documentation As First-Class Knowledge

Brain does not treat documentation as a cosmetic layer outside the memory system. It analyzes repo-facing surfaces such as `README.md`, architecture and operator docs, troubleshooting docs, and agent-instruction files so future documentation work can start from local precedent.

At normalization time, documentation signals and documentation patterns become part of the project snapshot alongside evidence-driven boundary rules and validation surfaces extracted from docs, scripts, and strong operator cues. At write time, the canonical writer can synthesize those patterns into `documentation-style-patterns.md` and use the stronger boundary and validation signals inside project notes. At retrieval time, documentation-shaped queries can surface those patterns alongside implementation learnings.

## Evidence Provenance Flow

Brain now carries a shared provenance model, `provenance-v1`, across the strong-brain pipeline.

1. Project analysis extracts evidence items from README sections, docs, agent guidance, manifests, and validation scripts.
2. Normalization preserves those evidence items inside the project snapshot and writes compact evidence traces into the retrieval corpus.
3. Chunking converts the strongest relevant evidence into vector metadata such as `evidenceQuality`, `confidence`, `supportCount`, `supportingSources`, and `derivedFrom`.
4. Retrieval returns both `whyMatched` and `whyTrusted` so local search results are explainable rather than opaque.
5. Consultation turns the top evidence into `trustSummary` and `localContext.evidenceBasis` so agents can see when local memory is strong enough and when web escalation is justified.
6. The canonical writer only surfaces selective trust signals in human-facing notes, such as confidence and supporting evidence lines, to avoid turning the vault into a metadata dump.

## Write Path: Sync and Canonicalization

```mermaid
sequenceDiagram
	participant Operator
	participant CLI as apps/cli
	participant Worker as apps/worker
	participant Scan as scanner/parser/normalizer
	participant Writer as canonical-writer
	participant Contract as vault-contract
	participant Vault as Obsidian vault
	participant Runtime as data/runtime

	Operator->>CLI: npm run brain:sync
	CLI->>Worker: runSync(...)
	Worker->>Scan: load and normalize project snapshots
	Worker->>Writer: syncNotes(config, state, projects)
	Writer->>Contract: cleanupDeprecatedVaultArtifacts(...)
	Writer->>Vault: write canonical project and global notes
	Writer->>Runtime: generate local launchers and runtime assets
```

The sync path is not just a note writer. It also bootstraps vault folders, ensures canonical note surfaces exist, removes deprecated vault artifacts, writes managed global notes, refreshes reusable documentation-style patterns, and generates local launchers such as `run-brain.sh`, `run-brain-mcp.sh`, and `com.local.ai-brain.plist` under `data/runtime/`.

The project-analysis stage is intentionally selective. It now prefers explicit boundary statements, validation commands, and strong documentation cues over generic README purpose text. If a repo does not provide evidence for a durable learning, Brain now leaves the learning surface thin instead of fabricating one from stack facts.

## Canonical Writer Path

`packages/obsidian-writer/canonical-writer.mjs` is the only active writer implementation.

Its active responsibilities are:

- `bootstrapVault(config)` to create canonical folders, static note scaffolding, and local launchers
- `syncNotes(config, state, projects)` to clean deprecated vault artifacts and rewrite canonical note surfaces
- `writeManagedKnowledgeNotes(config, state, projects)` to keep global notes aligned with runtime state
- `readProjectNoteContents(config, project)` to feed retrieval with canonical notes while stripping legacy marker-era content when encountered

There is no supported dual-writer or legacy renderer path. Compatibility shims may exist around old entrypoints, but they are not part of the canonical architecture.

## Retrieval and Consultation Flow

```mermaid
sequenceDiagram
	participant User as Developer or agent
	participant Entry as CLI or MCP tool
	participant Service as brain-service
	participant Vector as Chroma
	participant Vault as Canonical notes
	participant Reasoner as reasoner
	participant Research as research module

	User->>Entry: query or consult
	Entry->>Service: gatherLocalBrainContext(...)
	Service->>Vector: retrieveContext(...)
	Service->>Vault: readProjectNoteContents(...)
	Service->>Reasoner: reasonAboutQuery(...)
	Service->>Research: buildResearchConsultation(...)
	Research-->>Entry: mode, confidence, evidence, memory guidance
```

`brain.query` and `brain.consult` share the same local retrieval foundation. The difference is that `brain.consult` adds research mode selection, source prioritization, trust summarization, and memory guidance so agents know whether they should stay local or pull in external validation. Documentation-shaped queries can also reuse cross-project documentation patterns when Brain detects that the task is about repo presentation, architecture docs, operator docs, or agent guidance.

Inside that shared retrieval foundation, Brain now does more than semantic nearest-neighbor lookup. Query expansion still broadens short or messy prompts, but the final ranking now also weighs direct phrase matches, repo-specific intent, boundary/debugging/documentation cues, evidence quality, support traces, and confidence. The selection step still enforces diversity across note surfaces, but the final result list is re-sorted by final relevance so the operator surface remains coherent.

Managed embedder prewarm now sits directly in front of that retrieval path. Each Node.js runtime owns at most one shared Python embedder service, and the JavaScript side waits for an explicit startup handshake after the model is actually loaded. In the default `auto` mode, `brain:mcp` and `brain:doctor` block on that readiness once so the long-lived or multi-step paths expose cold-start cost up front. `brain:embed`, `brain:query`, and `brain:consult` start the same prewarm in the background so short-lived commands can overlap model load with other work. `brain:status` and `brain:mcp:healthcheck` skip prewarm so they remain lightweight and do not retain helper processes unnecessarily.

Those prewarm summaries are runtime operations, not knowledge artifacts. They are written into local state for status and doctor reporting, but they do not become query history, they do not count as usage-backed admission signals, and they never write project notes into the vault.

Cross-process CLI reuse is handled by a separate ownership layer: a Node-owned persistent embedder runner that serves local embedding requests over a Unix socket. Its PID, lock, and state files stay under `data/runtime/` and `data/state/`, it has explicit `start`, `status`, `restart`, and `stop` commands, and it performs stale PID and lock cleanup before claiming ownership. In `auto` mode, `brain:query` and `brain:consult` can start it on demand and later fresh CLI processes reuse it. In `require` mode, those commands fail clearly if the runner cannot become healthy. `brain:doctor` inspects and reports this runner but only uses it when it is already healthy or the operator required it.

The MCP server stays separate from that CLI runner. MCP keeps its own explicit startup prewarm inside the MCP-owned process rather than silently attaching to the CLI runner. That preserves the boundary between one-shot CLI ownership and long-lived MCP ownership.

## Local-First and Web-Assisted Model

| Mode | When it is appropriate | Expected behavior |
| --- | --- | --- |
| `local-only` | Local context is strong and the question is repo-shaped | Stay inside local notes, patterns, and learnings |
| `local-plus-web-assist` | Local context is useful but incomplete for current guidance | Start from local memory, then fetch only the missing official guidance |
| `web-first-local-adaptation` | The question is current, migration-heavy, version-sensitive, or security-sensitive | Lead with authoritative sources, then adapt the result back into the repo context |

Tier 1 sources are the default web targets: official docs, API references, migration guides, standards, and maintainer-authored security guidance.

## MCP and Agent Contract

The MCP server exposes eight stable tools:

- `brain.search`
- `brain.consult`
- `brain.synthesize_guidance`
- `brain.project_summary`
- `brain.related_patterns`
- `brain.recent_learnings`
- `brain.capture_learning`
- `brain.capture_research_candidate`

The intended agent sequence is:

1. `brain.consult`
2. Optional web research from authoritative sources when the returned mode requires it
3. `brain.synthesize_guidance`
4. Implementation or recommendation
5. Selective write-back through either `brain.capture_learning` or `brain.capture_research_candidate`

`brain.search` remains important, but it is the retrieval debugger rather than the preferred first step for non-trivial work.

`brain.consult` now also exposes a decision trace: a scored breakdown of why the runtime stayed local, recommended local-plus-web assist, or escalated to web-first-local-adaptation. That makes consultation behavior inspectable instead of leaving it buried inside boolean gates.

## Validation and Anti-Drift Protections

| Guardrail | What it checks |
| --- | --- |
| `brain:validate:vault` | Unexpected project note files, legacy markers, per-project knowledge mirrors, per-project logs, and runtime artifacts in the vault |
| `brain:doctor` | Vault validity, knowledge model version mismatches, deprecated retrieval surfaces in chunk cache, missing embeddings, managed embedder prewarm readiness, provenance-aware query smoke results, consult decision-trace behavior, project-level retrieval precision, citation completeness, usage-backed admission counters, retrieval latency warnings, and MCP tool availability |
| `brain:mcp:healthcheck` | Whether the MCP server starts cleanly and exposes the expected `brain.*` tool surface without keeping a long-lived MCP or embedder helper alive |

The anti-drift model is explicit: remove deprecated artifacts before they survive into retrieval, then run smoke tests that prove the runtime still behaves the way the docs describe.

## Configuration Precedence and Storage Defaults

Configuration resolution is consistent across CLI and MCP:

1. CLI flags
2. Environment variables
3. `brain.config.json`
4. Safe defaults

Default locations are intentionally local and portable:

- projects root: parent directory of the Brain repository
- vault root: `~/Obsidian/Brain` when present, otherwise `./obsidian-sync`
- data root: `./data`

Runtime behavior also exposes two embedder-specific knobs across CLI, environment, and config file resolution:

- `embedderPrewarm` or `BRAIN_EMBEDDER_PREWARM`: `auto`, `blocking`, `background`, or `off`
- `embedderPrewarmTimeoutMs` or `BRAIN_EMBEDDER_PREWARM_TIMEOUT_MS`: timeout budget for managed prewarm, default `12000`

Persistent runner configuration is resolved through the same precedence chain:

- `embedderRunnerMode` or `BRAIN_EMBEDDER_RUNNER_MODE`: `off`, `auto`, or `require`
- `embedderRunnerStartupTimeoutMs` or `BRAIN_EMBEDDER_RUNNER_STARTUP_TIMEOUT_MS`: wait budget while a runner becomes healthy
- `embedderRunnerRequestTimeoutMs` or `BRAIN_EMBEDDER_RUNNER_REQUEST_TIMEOUT_MS`: timeout for one request sent through the runner
- `embedderRunnerIdleTimeoutMs` or `BRAIN_EMBEDDER_RUNNER_IDLE_TIMEOUT_MS`: idle shutdown timer for the runner, `0` to disable idle shutdown
- `embedderRunnerSocketPath` or `BRAIN_EMBEDDER_RUNNER_SOCKET_PATH`: explicit socket override when the default path is not appropriate

## Secondary Surfaces

`watch`, the optional local API, and sandbox self-test are real features, but they are secondary to the core operator path. The system should still make sense if a user only ever touches `init`, `sync`, `validate:vault`, `doctor`, `embed`, `consult`, `query`, `status`, and `mcp`.