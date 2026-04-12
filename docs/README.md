# Documentation Map

Use this folder as the fast path from the GitHub landing page to the exact document that answers a real question. In Brain, documentation is not treated as filler around the runtime. It is part of the product surface, the onboarding path, the agent instruction layer, and the architecture communication layer.

## Start Here

1. [../README.md](../README.md) for the product identity, architecture overview, and happy path.
2. [FIRST_RUN.md](FIRST_RUN.md) for machine setup and first successful run.
3. [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md) for daily commands, health checks, and recovery playbooks.
4. [ARCHITECTURE.md](ARCHITECTURE.md) for the system design, boundaries, and canonical writer path.

## If You Need...

| Question | Read |
| --- | --- |
| What is this repo and why does it exist? | [../README.md](../README.md) |
| How do I get to a working local setup quickly? | [FIRST_RUN.md](FIRST_RUN.md) |
| What commands do I run every day? | [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md) |
| What are the real boundaries and data flows? | [ARCHITECTURE.md](ARCHITECTURE.md) |
| How should MCP be wired into VS Code and agents? | [MCP_INTEGRATION.md](MCP_INTEGRATION.md) |
| What rules keep the system from drifting? | [DESIGN_RULES.md](DESIGN_RULES.md) |
| What does a good query or consultation result look like? | [EXAMPLE_RETRIEVAL.md](EXAMPLE_RETRIEVAL.md) |
| What instructions should Copilot follow in this repo? | [../.github/copilot-instructions.md](../.github/copilot-instructions.md) |
| What broader agent rules apply here? | [../AGENTS.md](../AGENTS.md) |

## Canonical Entry Points

The GitHub-facing documentation set is intentionally layered:

- [../README.md](../README.md) is the repository entry point.
- [ARCHITECTURE.md](ARCHITECTURE.md) is the authoritative design document.
- [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md) is the day-to-day operating manual.
- [MCP_INTEGRATION.md](MCP_INTEGRATION.md) is the integration contract for VS Code and agent tooling.
- [../.github/copilot-instructions.md](../.github/copilot-instructions.md) and [../AGENTS.md](../AGENTS.md) define repo-specific agent behavior.

## Documentation Intelligence

Brain now treats reusable documentation structure as managed knowledge, not just presentation polish. After sync, the configured vault can hold cross-project documentation patterns in `04_Knowledge_Base/documentation-style-patterns.md`, alongside implementation-focused reusable patterns.

That note exists to preserve high-signal repo-facing patterns such as:

- README hero structure and section pacing
- scan-friendly architecture and operator docs
- troubleshooting layouts that move from symptom to check to recovery
- agent instruction surfaces that keep Copilot and other agents aligned with the real system

## Reading Order By Role

- New operator: [FIRST_RUN.md](FIRST_RUN.md) -> [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md)
- Maintainer or architect: [../README.md](../README.md) -> [ARCHITECTURE.md](ARCHITECTURE.md) -> [DESIGN_RULES.md](DESIGN_RULES.md)
- MCP or Copilot integrator: [MCP_INTEGRATION.md](MCP_INTEGRATION.md) -> [../.github/copilot-instructions.md](../.github/copilot-instructions.md)
- Agent author or automation maintainer: [../AGENTS.md](../AGENTS.md) -> [../.github/copilot-instructions.md](../.github/copilot-instructions.md)