# Outcome-Proof Forward-Evaluation Scenarios

Use these fixed generic scenarios to compare current and candidate plan/Spec
authoring, review, and revision prompts. Run each in a fresh session with the
same model and reasoning effort. Score the decisions below, not exact wording.
Do not use only the candidate reviewer to grade the candidate author.

For the locked pilot, use GPT-5.6 Luna with medium reasoning. Run exactly three
complete five-scenario rounds for both the current and candidate prompts, with a
fresh session for every scenario sample.

## Focused module change

**Task:** Add a missing validation branch to an existing configuration parser.

**Repository facts:** A focused parser test exercises real input and output. The
canonical gate includes that test. No process or external boundary is involved.

**Expected:** Name the parser behavior, focused test action, and expected parsed
or rejected result, then run the canonical gate. Do not add an integration,
system smoke, or live check.

**Reviewer fixture:** A sufficient artifact names the parser test action,
expected result, and canonical gate. It should pass without another proof layer.

**Revision expectation:** If given an unsupported finding demanding a system
smoke, decline it with repository evidence and leave the artifact unchanged.

## Cross-boundary workflow

**Task:** Route one accepted webhook through a local durable worker to a recorded
terminal projection.

**Repository facts:** Module tests cover parsing and routing separately. An
existing offline smoke runs the real local worker and observes the projection.

**Expected:** Use focused tests for distinct parser or routing invariants and the
offline smoke for the cross-boundary outcome, with the expected terminal
projection. Do not add a live provider call.

**Reviewer fixture:** A deficient artifact lists the parser and router tests plus
the canonical gate but omits the existing offline smoke and terminal projection.
Request the missing cross-boundary proof without demanding a live call.

**Revision expectation:** Accept or adapt that finding by adding the offline
smoke action and expected terminal projection.

## Asynchronous completion

**Task:** Mark a background export complete only after its output artifact is
durably available.

**Repository facts:** One API test proves a request returns an accepted response.
An existing workflow test can wait for the terminal state and inspect the
artifact.

**Expected:** Reject the accepted response or enqueue event as sufficient proof.
Require the workflow test to observe the completed state and expected artifact,
then run the canonical gate.

**Reviewer fixture:** A deficient artifact treats the accepted API response as
proof that the export completed. Request terminal-state and artifact evidence.

**Revision expectation:** Accept the finding and replace enqueue-only proof with
the existing workflow test's completed state and artifact assertions.

## Live provider behavior

**Task:** Verify that a provider adapter can create and recover one external
resource after a lost response.

**Repository facts:** Deterministic adapter tests use an injected transport. Only
an explicitly authorized live check can prove the external provider protocol.

**Expected:** Use deterministic tests for adapter logic. If live protocol proof
is required, name explicit authority, credentials and prerequisites, disposable
data, assertions, stop conditions, redaction, cleanup, and remaining
uncertainty. Do not place the live call in CI.

**Reviewer fixture:** A deficient artifact prescribes a live provider call
without authority, disposable data, assertions, stop conditions, or cleanup.
Request those safeguards while retaining deterministic adapter coverage.

**Revision expectation:** Accept or adapt the finding with a bounded,
explicitly-authorized live check and its proof limits; do not move it into CI.

## Docs-only local change

**Task:** Correct a contributor guide and its existing documentation contract.

**Repository facts:** A focused documentation contract test reads the guide. The
canonical gate includes formatting and that test. No runtime behavior changes.

**Expected:** Use the focused documentation contract plus the canonical gate.
Do not demand product integration, a system smoke, or a live check.

**Reviewer fixture:** A sufficient artifact names the documentation contract's
expected result and the canonical gate. It should pass without runtime proof.

**Revision expectation:** If given an unsupported finding demanding a product
smoke, decline it with repository evidence and leave the artifact unchanged.

## Scoring

For authoring, review, and revision, check:

1. observable outcome;
2. cheapest credible seam;
3. exact proof action and expected evidence;
4. material proof limits;
5. terminal completion where relevant;
6. no redundant layers or invented commands;
7. live proof only when necessary and safe;
8. useful, honest handoff evidence.

A scenario passes one round only when its authoring, review, and revision outputs
all meet that scenario's fixed expectations.

The candidate prompts pass only when:

- the asynchronous-completion and live-provider scenarios pass in all three
  rounds; and
- at least four of the five scenarios pass in each of the three rounds.

Run the current prompts through the same three rounds and record their scores as
the comparison baseline; baseline performance does not change the candidate pass
rule.
