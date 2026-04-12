# Brain Agent Guide

This repository has two instruction layers:

1. The Brain-specific operating rules in this section.
2. The managed GitNexus code-intelligence rules in the section that follows.

## What This Repo Is

Brain is the local-first developer memory runtime. It reads sibling repositories as read-only input, writes canonical knowledge notes into an Obsidian vault, embeds them locally, and exposes that memory through MCP for VS Code and Copilot.

## Start With These Files

- `README.md` for the GitHub-facing product entry point
- `docs/ARCHITECTURE.md` for the real system design and data flow
- `docs/OPERATOR_GUIDE.md` for command workflows and recovery steps
- `.github/copilot-instructions.md` for repo-specific Copilot behavior

## Brain-Specific Operating Rules

- Sibling repositories under the configured projects root are read-only unless the user explicitly asks to modify Brain itself.
- The configured vault is writable knowledge output, not application runtime.
- Runtime state belongs under `data/`, not inside the vault.
- The canonical project note set is exactly `overview.md`, `architecture.md`, `learnings.md`, and `prompts.md`.
- Cross-project documentation knowledge belongs in `04_Knowledge_Base/documentation-style-patterns.md` alongside reusable implementation patterns.
- Do not reintroduce per-project `logs.md`, per-project knowledge mirrors, legacy generated markers, or runtime artifacts into the vault.
- `packages/obsidian-writer/canonical-writer.mjs` is the only supported active note writer.

## Brain Tool Usage

- For non-trivial work, use `brain.consult` first.
- Use `brain.search` when you are debugging retrieval quality, not when you want the first high-level recommendation.
- For README, architecture-doc, operator-doc, and agent-instruction work, prefer local documentation-style patterns and benchmark repo surfaces before inventing a new layout.
- Respect consultation modes exactly:
	- `local-only`
	- `local-plus-web-assist`
	- `web-first-local-adaptation`
- After external research, use `brain.synthesize_guidance` to adapt it back into the current repo.
- Use `brain.capture_learning` only for proven, reusable learnings.
- Use `brain.capture_research_candidate` only for provisional findings that are not yet part of the semantic core.

## Validation Expectations

- Run `npm run brain:init` after launcher or MCP integration changes.
- Run `npm run brain:validate:vault` after vault-writing or cleanup changes.
- Run `npm run brain:doctor` after retrieval, consultation, or MCP changes.
- Run `npm run brain:test` after changes to retrieval, embeddings, or MCP tool behavior.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **brain** (555 symbols, 1645 relationships, 46 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/brain/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/brain/context` | Codebase overview, check index freshness |
| `gitnexus://repo/brain/clusters` | All functional areas |
| `gitnexus://repo/brain/processes` | All execution flows |
| `gitnexus://repo/brain/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->