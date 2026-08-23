---
name: agentic-code-review
description: Review a Git pull request, branch, commit, or working-tree diff produced by an agent using independent contract-compliance and adversarial passes. Use before merging agent-authored changes or when asked for an evidence-backed review; do not implement fixes unless separately requested.
---

# Agentic Code Review

Review the exact change set, not the author's general effort. Prefer a reviewer that did not author the change and has not received the author's conclusions. Stay read-only: inspect and validate, but do not modify the branch, post comments, approve, merge, or fix findings unless the user separately authorizes that action.

## Establish the review target

1. Resolve the exact PR, base/head refs, commit, or working-tree state. Record both SHAs when applicable.
2. Read `AGENTS.md`, the linked task/plan, applicable specs and ADRs before judging implementation.
3. Inspect the full diff and directly supporting code. Do not silently widen into a baseline audit of unrelated code.
4. Identify changed trust boundaries and high-risk surfaces before running checks.
5. Treat author/PR claims as hypotheses. Distinguish evidence you observed, CI evidence you inspected, and claims you could not verify.

If the target changes during review, restart or clearly limit the result to the recorded head SHA. If the base, desired behavior, or relevant spec cannot be established, report the blocker instead of guessing.

## Run two passes

Keep notes for each pass separate until both searches finish. When another independent reviewer/session is available, give the second pass only the target, specs, diff, and this skill—not the first pass's findings. Otherwise disclose that both passes shared one reviewer context.

### Pass 1 — contract and engineering correctness

Trace `Requirement → Spec → Acceptance criterion → Test → Implementation → Validation → Documentation`.

Check that the change:

- implements the approved outcome and no unapproved scope;
- preserves public contracts, schemas, migrations, compatibility and repository boundaries;
- follows the task's TDD and validation requirements with tests that would fail for the defect;
- handles success, error, empty, partial, retry and permission states that are reachable;
- updates affected docs and removes stale statements;
- remains understandable and no more complex than the requirement needs.

Do not block on personal style. Mechanical formatting belongs to CI. Label optional polish as non-blocking.

### Pass 2 — adversarial and regression analysis

Read [the adversarial method](references/adversarial-method.md) completely. Build plausible failure and abuse paths from changed inputs through state changes and outputs. Prioritize authorization, workspace isolation, money, irreversible history, concurrency, idempotency, dates, migrations, file handling, secrets/logging and recovery according to the changed surface.

Try to falsify the implementation with focused tests or read-only reproduction when practical. A scanner or security plugin may supplement this pass but never replaces path analysis and validation.

## Finding standard

Report a finding only when all are present:

- a changed line or directly affected behavior;
- a reachable scenario under supported inputs or a credible attacker/failure model;
- observable impact on correctness, security, privacy, data, UX or operations;
- evidence from code, tests, runtime, logs or an explicitly identified proof gap;
- a bounded remediation direction and a way to verify it.

Do not report speculative possibilities, duplicates, pre-existing unrelated defects, or preference-only feedback as findings. If evidence is insufficient, state a question or residual risk rather than asserting a defect.

Use severity:

- **P0:** immediate widespread compromise, unrecoverable data loss, or release-stopping failure.
- **P1:** likely serious security, isolation, financial, migration, or core-journey failure.
- **P2:** real localized defect or missing required behavior with contained impact.
- **P3:** optional improvement; never blocks by itself and normally belongs outside the findings list.

## Validate and report

Run the smallest relevant checks first, then broader checks proportional to risk. For Casei, follow `docs/testing/README.md` and the environment rules in `AGENTS.md`. Visual behavior requires the project's UX/UI skill and browser evidence; do not infer it from JSX or screenshots alone.

Return findings first, ordered by severity. Each finding includes:

1. `[P#]` concise imperative title;
2. file and exact line or smallest useful range;
3. failing scenario and impact;
4. governing spec/invariant when applicable;
5. evidence and any proof gap;
6. minimal safe direction and verification.

Then report:

- reviewed target/base and pass independence;
- checks actually run and their results;
- requirements/areas covered;
- residual risks or unverified claims;
- merge recommendation: `block`, `approve after fixes`, or `no blocking findings`.

An empty findings list is valid. Never manufacture feedback to make a review look useful.
