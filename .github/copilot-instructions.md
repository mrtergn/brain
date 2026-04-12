# Brain Repo Instructions

## What This Repo Is

Brain is the local-first developer memory runtime used to give VS Code and Copilot durable project context. It reads sibling repositories as read-only source input, writes canonical notes into an Obsidian vault, embeds that memory locally, and exposes it through MCP.

This repository is not a generic AI platform, a vault-shaped runtime, or a place to accumulate uncontrolled research notes.

## Canonical Architecture

Treat these files as authoritative when reasoning about the system:

- `apps/cli/index.mjs`: operator command surface
- `apps/worker/index.mjs`: orchestration behind CLI operations
- `apps/mcp-server/index.mjs`: sole MCP entrypoint for `local-brain`
- `packages/brain-service/index.mjs`: search, consult, synthesis, project summary, related patterns, recent learnings, and write-back tools
- `packages/research/index.mjs`: consultation mode selection and external-guidance synthesis
- `packages/obsidian-writer/canonical-writer.mjs`: only active note writer
- `packages/vault-contract/index.mjs`: canonical note paths, cleanup rules, and validation logic

Use the docs as the GitHub-facing guide layer:

- `README.md`: repo entry point and high-level product story
- `docs/ARCHITECTURE.md`: system design and data flow
- `docs/OPERATOR_GUIDE.md`: day-to-day commands and recovery steps
- `docs/MCP_INTEGRATION.md`: MCP contract and VS Code integration
- `docs/DESIGN_RULES.md`: architectural boundaries and drift-prevention rules

## Non-Negotiable Boundaries

- Treat sibling repositories under the configured projects root as read-only, except for this Brain repository.
- Treat the configured Obsidian vault as writable knowledge output, not as application runtime.
- Keep runtime state under `data/`, not inside the vault.
- Do not overwrite manual note sections when changing note generation or write-back logic.
- Do not reintroduce per-project `logs.md`, per-project knowledge mirrors, generated marker sections, or runtime artifacts into the vault.
- Do not treat `obsidian-sync/` as the default live vault; it is the sandbox validation vault unless configuration says otherwise.

## Canonical Vault Contract

Per project, the only supported managed note set is:

- `overview.md`
- `architecture.md`
- `learnings.md`
- `prompts.md`

Canonical global notes are:

- `04_Knowledge_Base/reusable-patterns.md`
- `04_Knowledge_Base/documentation-style-patterns.md`
- `03_Agent_Notes/query-history.md`
- `03_Agent_Notes/debugging-insights.md`
- `03_Agent_Notes/agent-workflow-notes.md`
- optional `03_Agent_Notes/research-candidates.md`
- `06_Summaries/Portfolio_Summary.md`
- system notes under `99_System/`

Important memory rule: `research-candidates.md` is not part of the semantic core by default. It is a holding area for promising but unproven external findings.

Documentation rule: repo-facing docs are part of the operating surface. README work, architecture docs, operator docs, and agent instructions should reuse local documentation-style patterns when strong benchmark repositories exist.

## How To Use Brain Safely

- For non-trivial development tasks, call `brain.consult` first instead of jumping directly to `brain.search`.
- Use `brain.search` when you need retrieval visibility, not when you need the first operational recommendation.
- For README, docs, `AGENTS.md`, or `.github/copilot-instructions.md` work, consult current-project docs and documentation-style patterns before drafting a new structure.
- Respect the returned mode:
  - `local-only`: stay within local brain context.
  - `local-plus-web-assist`: use local context first, then fetch only the missing or current guidance.
  - `web-first-local-adaptation`: gather authoritative guidance first, then adapt it to the project using local context.
- Prefer current-project context first, then reusable cross-project knowledge.
- Keep retrieval outputs concise, source-backed, and implementation-oriented.

## Web Research And Memory Hygiene

- Use web research only when the question is current, version-sensitive, migration-sensitive, security-sensitive, or weakly covered locally.
- Prefer Tier 1 sources first: official docs, API references, standards, release notes, migration guides, and maintainer-authored security guidance.
- After external research, call `brain.synthesize_guidance` before adapting the result to the repo.
- Use `brain.capture_research_candidate` only for promising findings that are not yet implementation-proven.
- Use `brain.capture_learning` only for durable, validated patterns or debugging wins.
- Never auto-promote raw external findings into permanent notes.

## Change Discipline

- Keep the main workflow focused on `init`, `sync`, `validate:vault`, `doctor`, `embed`, `query`, `consult`, `status`, and `brain:mcp`.
- Preserve the canonical writer path. Do not introduce a second active note writer.
- If you change vault-writing behavior, keep `README.md`, `docs/ARCHITECTURE.md`, and `docs/OPERATOR_GUIDE.md` aligned.
- If you change MCP or agent-facing behavior, keep `docs/MCP_INTEGRATION.md` and this file aligned.
- If you change the note model, update the vault contract and validation logic together.

## Validation Expectations

- Run `npm run brain:init` after changing runtime script generation or MCP integration.
- Run `npm run brain:validate:vault` after changing vault-writing, cleanup behavior, or note-model rules.
- Run `npm run brain:doctor` after integrated changes that affect retrieval, consultation, or MCP readiness.
- Run `npm run brain:test` after changing embeddings, retrieval, or MCP tool code.
- Validate retrieval with a real query such as `npm run brain:query -- "auth bug solution"`.
- Validate research-mode selection with a real query such as `npm run brain:consult -- "best practice for token refresh handling"`.
- Validate automatic integration through the MCP server, not only the CLI. Use `npm run brain:mcp:healthcheck` for a quick MCP readiness check.