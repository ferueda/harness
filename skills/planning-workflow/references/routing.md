# Planning routing

## shape-requirements ↔ diagnose-issue

| Question | Skill |
|----------|-------|
| What should we build? | shape |
| Is this bug/risk real in the code? | diagnose |
| Brief asserts current behavior | shape → diagnose |
| Diagnose found multiple directions | diagnose → shape **gate** |
| Diagnose **Not Found** / **Invalidated** | report evidence; shape **interview** only if the goal was wrong |

## When to skip steps

| Skip | When |
|------|------|
| shape | Ticket has repro + clear acceptance criteria |
| diagnose | Greenfield feature with no code-truth claims |
| review-spec | Trivial plan or prior review on same revision |
| create-plan | Single-file fix after gate |
| handoff-work | Same agent continues in one session |

## Artifact paths

| Artifact | Path |
|----------|------|
| Requirements brief | `dev/briefs/YYMMDD-short-slug.md` |
| Problem definition | inline or `dev/issues/YYMMDD-short-slug.md` |
| Implementation plan | `dev/plans/YYMMDD-short-slug.md` |

Fixtures: [routing-scenarios.md](routing-scenarios.md)
