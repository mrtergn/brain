# Example Retrieval and Consultation Output

This file shows what good output looks like from Brain's local retrieval and research-aware consultation flow.

## How To Read The Output

| Field | Why it matters |
| --- | --- |
| `mode` | Tells the operator or agent whether the answer should stay local or escalate to web validation |
| `localConfidence` | Explains how strong the local memory signal really is |
| `decisionTrace` | Shows why Brain stayed local or escalated instead of hiding the routing logic |
| `topResults` | Shows which projects and note types drove the answer |
| `researchDecision` | Makes the escalation rule explicit instead of implicit |
| `memoryGuidance` | Tells you whether the result should stay ephemeral, become a candidate, or become durable memory |

## Scenario 1: Local-Only Repo Memory

**Query**

`Which projects use docs-as-code knowledge capture and reusable patterns?`

**Expected mode**

`local-only`

**Why it stays local**

- The question is about repo history and stored patterns already inside the local brain.
- No version-sensitive or security-sensitive external guidance is required.
- The right answer should come from project notes, not from the public web.

**Likely top projects**

- `docs-benchmark`
- `patterns-service`
- `workflow-tool`
- `example-app`

**How to act on it**

- Start from the highest-confidence knowledge or learning notes.
- Compare repeated note structures before inventing a new documentation model.
- Keep the answer inside local evidence rather than escalating to external sources.

## Scenario 2: Repository-Facing Documentation Refinement

**Query**

`How should Brain structure its README and docs if docs-benchmark is the benchmark?`

**Expected mode**

`local-only`

**Why it stays local**

- The benchmark repositories and prior documentation patterns already live inside the local brain.
- The task is about local repo presentation, onboarding quality, and documentation rhythm, not external standards.
- The right answer should reuse proven local documentation patterns before inventing new layout ideas.

**Likely top projects**

- `docs-benchmark`
- `brain`

**How to act on it**

- Start from documentation-style patterns and strong local README or doc surfaces.
- Reuse proven section pacing, anchor navigation, showcase structure, and diagram discipline.
- Keep architecture, operator workflow, and agent guidance aligned while improving the GitHub-facing presentation.

## Scenario 3: Web-First Local Adaptation

**Query**

`best practice for token refresh handling`

**Expected mode**

`web-first-local-adaptation`

**Why it escalates**

- The question is security-sensitive.
- It asks for current best practice, not just repo precedent.
- Local patterns may be useful, but they are not authoritative enough by themselves.

**Expected flow**

1. `brain.consult` checks local auth and session patterns first.
2. The returned mode includes a decision score and escalation drivers, then recommends Tier 1 research.
3. External findings are gathered from official or standards-backed sources.
4. `brain.synthesize_guidance` adapts those findings back into the current repo.
5. If the result is promising but not yet implementation-proven, it becomes a research candidate instead of durable memory.

## Scenario 4: Local Plus Web Assist

**Query**

`current recommended pattern for request retries`

**Expected mode**

`local-plus-web-assist`

**Why this is mixed**

- Local patterns are still useful because Brain can surface existing retry boundaries, client wrappers, or shared transport modules.
- External guidance matters because retry safety depends on current framework behavior, idempotency, and backoff rules.

**Expected flow**

1. Local retrieval reveals the current project and cross-project retry boundaries.
2. External research validates current retry safety, exponential backoff, and idempotency guidance from authoritative docs.
3. `brain.synthesize_guidance` recommends a repo-shaped implementation, such as centralizing retries at the shared client boundary instead of scattering them across callers.

## Write-Back Targets

| Output type | Destination | Embedded |
| --- | --- | --- |
| Raw query and consultation telemetry | `data/state/brain-state.json` | No |
| Curated query guidance | `03_Agent_Notes/query-history.md` | Yes after the next embedding cycle |
| Research candidate | `03_Agent_Notes/research-candidates.md` | No |
| Proven project learning | `01_Projects/<ProjectName>/learnings.md` | Yes |
| Cross-project reusable pattern | `04_Knowledge_Base/reusable-patterns.md` | Yes after the next embedding cycle |
| Cross-project documentation pattern | `04_Knowledge_Base/documentation-style-patterns.md` | Yes after the next embedding cycle |

## Query History Expectations

`query-history.md` is now intentionally small and curated. It should keep only:

- query shapes that repeatedly produce useful recall
- strong and weak retrieval zones worth remembering
- query hygiene rules
- reusable wording that deserves promotion into prompts or reusable patterns

Raw query and consultation telemetry, including exact prompt text, returned mode, local confidence, or result ids, stays in `data/state/brain-state.json`.

Runtime-only operations such as managed embedder prewarm, doctor latency diagnostics, and MCP startup readiness also stay in `data/state/brain-state.json`.

That separation keeps the vault readable while preserving the full operational trace for runtime admission and status reporting.

## What Good Output Feels Like

Good Brain output should be:

- source-backed instead of generic
- explicit about whether web research is needed
- narrow enough to guide implementation safely
- disciplined about what becomes permanent memory