# Design Rules

Brain has a narrow product shape on purpose. These rules exist to keep the repository from drifting back into a generic note generator, a vault-shaped runtime dump, or a web-clipping workflow.

## Product Identity

Brain is a local-first developer memory runtime.

It is responsible for:

- scanning sibling repositories without modifying them
- writing canonical project memory into the configured vault
- embedding that memory locally for retrieval
- exposing that memory through CLI and MCP for operators and agents
- treating documentation as part of the repository interface, not as disposable prose around the runtime

It is not responsible for becoming a generic hosted AI platform, a runtime hidden inside the vault, or an unbounded research archive.

## Non-Negotiable Boundaries

| Rule | Meaning |
| --- | --- |
| Sibling repositories are read-only | Brain can scan them, summarize them, and learn from them, but not modify them as part of its normal model |
| The vault is knowledge output | It may contain managed notes and curated human knowledge, but not runtime logs, caches, launchers, or state |
| `data/` is runtime state | It is local, regenerable, and intentionally separate from durable markdown knowledge |
| The writer path is singular | `packages/obsidian-writer/canonical-writer.mjs` is the only supported active note writer |
| Deprecated note models stay deprecated | Per-project `logs.md`, knowledge mirrors, and generated-marker sections are drift, not optional compatibility layers |

## Canonical Knowledge Model

The supported note surfaces are intentionally narrow:

- per project: `overview.md`, `architecture.md`, `learnings.md`, `prompts.md`
- cross-project knowledge: `04_Knowledge_Base/reusable-patterns.md`
- cross-project documentation knowledge: `04_Knowledge_Base/documentation-style-patterns.md`
- agent notes: `query-history.md`, `debugging-insights.md`, `agent-workflow-notes.md`, and optional `research-candidates.md`
- system notes: `99_System/*.md`

Anything outside that model must justify itself against the core product story. In most cases, the right answer is to strengthen the existing notes rather than add a new note type.

## Memory Promotion Model

| Level | Meaning | Destination | Embedded |
| --- | --- | --- | --- |
| Level A: ephemeral | Working context that should not persist | Nowhere permanent | No |
| Level B: candidate | Promising external finding that is not yet implementation-proven | `03_Agent_Notes/research-candidates.md` | No |
| Level C: proven pattern | Durable, validated learning or reusable implementation or documentation guidance | Project `learnings.md`, `04_Knowledge_Base/reusable-patterns.md`, or `04_Knowledge_Base/documentation-style-patterns.md` | Yes, through `capture_learning` or the next embedding cycle |

The point of the model is to keep retrieval trustworthy. Raw external summaries should not automatically become permanent memory.

## Provenance and Trust Rules

- Durable memory should carry explicit source traces whenever the repo exposes them. If Brain cannot support a claim, it should mark it as weak or omit it instead of inventing certainty.
- Boundary rules and validation surfaces should come from repo evidence such as docs, agent guidance, or runnable scripts before they fall back to heuristics.
- Retrieval and consultation should explain trust, not only semantic similarity. Local matches without strong support must remain visibly weaker than evidence-backed matches.
- The vault may surface selective confidence and evidence lines for human readers, but it must not become a raw provenance dump or metadata mirror.
- External findings do not become durable memory until they are proven enough to survive the promotion model above.

## Documentation Intelligence Rules

- Documentation work should start from real repo evidence, not generic README boilerplate.
- README, architecture docs, operator docs, troubleshooting docs, and agent-instruction files are part of the system interface.
- Reusable documentation patterns belong in `documentation-style-patterns.md`, not hidden inside ad hoc notes or issue threads.
- Documentation structure should clarify the product, the operator workflow, and the architectural boundaries before it tries to impress visually.

## Retrieval and Research Rules

- Use `brain.consult` first for non-trivial work.
- Use `brain.search` when debugging retrieval quality, not when deciding what to do next.
- Prefer local project knowledge over web research whenever confidence is strong enough.
- Use web research only when the task is current, version-sensitive, security-sensitive, migration-related, or weakly covered locally.
- When web research is needed, prefer Tier 1 sources first: official docs, standards, release notes, migration guides, and maintainer-authored security guidance.
- After external research, synthesize it back into the repo through `brain.synthesize_guidance` instead of dumping links or summaries.

## Writer and Validation Rules

- `brain:sync` may rewrite canonical note content and remove deprecated vault artifacts.
- `brain:sync` must not recreate deprecated note types or marker boilerplate.
- `brain:validate:vault` is the structural contract check.
- `brain:doctor` is the operational contract check, including provenance-aware query and consult smoke behavior.
- `brain:init` must be rerun after launcher or MCP integration changes that affect generated runtime assets.

## Design Preferences

- Prefer a small, high-signal happy path over a larger feature surface.
- Prefer configuration over machine-specific hardcoding.
- Prefer recreated runtime state over manually curated local artifacts.
- Prefer transformed engineering memory over copied best-practice prose.
- Prefer stronger capture quality over more note volume.
- Prefer improving day-to-day leverage before adding new infrastructure breadth.

## Decision Test Before Adding Anything New

Before adding a new surface, note type, workflow, or write-back behavior, answer these questions:

1. Does it improve daily development leverage in a way the current model cannot?
2. Does it preserve the vault/runtime separation?
3. Does it keep the canonical note model clean?
4. Can the same outcome be achieved by improving learning capture or retrieval quality instead?

If those answers are weak, the change is probably outside Brain's intended shape.