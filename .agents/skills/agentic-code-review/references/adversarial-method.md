# Adversarial review method

Read this reference only for Pass 2 of an agentic code review.

## Preserve independence

Begin from the target SHA, intended behavior, specs and raw diff. Do not read the first pass's candidate findings until this pass has produced its own list. This reduces anchoring and correlated omission; it does not make two passes by one model fully independent. Prefer a different agent/session from the author, and a fresh reviewer for this pass when available.

## Build paths, not a generic checklist

For each changed entry point:

1. identify input sources and who controls them;
2. trace validation, normalization and authorization;
3. follow domain decisions and state transitions;
4. identify database, filesystem, network, cache, log and UI sinks;
5. test alternate ordering, repetition, partial failure and concurrent access;
6. compare the observed outcome with the governing invariant.

Inspect supporting code outside the diff only when needed to prove reachability or impact. Record a proof gap when runtime, infrastructure or external behavior cannot be verified.

## Casei risk triggers

Use only the lanes activated by the diff.

### Identity, authorization and tenancy

- authenticated actor differs from target user;
- valid entity ID belongs to another workspace;
- role changes between read and write;
- platform role is confused with workspace membership;
- RLS context is absent, stale, session-scoped or executed under a bypass role;
- cache, URL or background job carries data across workspace changes.

### Money and financial history

- JSON/JavaScript precision, sign or currency mismatch;
- purchase, fatura payment, loan principal, goal allocation or reversal is counted twice;
- planned data changes actual balance;
- published ledger entry is updated/deleted instead of reversed;
- multi-entry command can commit partially;
- installment rounding does not conserve the original total.

### Retry, concurrency and jobs

- repeated request, double tap, timeout or worker retry duplicates effects;
- same idempotency key with a different payload is accepted;
- optimistic concurrency is bypassed or last-write-wins loses intent;
- locks span slow external work, leases expire incorrectly, or workers process the same job;
- outbox and domain mutation can diverge;
- cancellation reports more rollback than actually occurred.

### Dates and schedules

- UTC conversion changes a civil day;
- month-end, leap year or due-before-close crosses the wrong cycle;
- timezone edits rewrite history;
- schedule generation produces duplicates or mutates completed occurrences;
- future/overdue state is stored when it should be derived.

### Files, imports and exports

- macro/formula execution, CSV injection, zip/path traversal or excessive resource use;
- authorization checked at job creation but not at download/application;
- temporary object key or signed URL leaks identity or outlives policy;
- partial import overwrites edits made after preview;
- parser coercion silently changes dates, encoding, quantity or cents.

### Privacy, errors and operations

- value, description, token, email, file or secret enters logs/audit/errors;
- not-found/forbidden differences enumerate accounts or workspace data;
- failure lacks correlation or retry semantics;
- migration cannot roll forward safely, locks production tables unexpectedly, or lacks representative rollback/recovery evidence;
- operational admin gains content access or unscoped bypass.

### UI and accessibility

- required consequence is hidden behind progressive disclosure;
- mutation appears successful while offline or after partial failure;
- form loses valid data or focus on error/conflict;
- essential action depends on hover, swipe, drag, color or pointer;
- overlay focus, Escape, title or return-focus behavior breaks;
- narrow/tablet layouts hide required information or sticky actions cover focus/errors.

## Evidence hierarchy

Prefer, in order appropriate to the claim:

1. reproducible runtime/test failure;
2. database constraint or transaction behavior observed in integration;
3. deterministic code path with supported input;
4. authoritative platform/library documentation;
5. explicit inference with a named proof gap.

A passing happy-path test does not rebut a failing adversarial scenario. Conflicting evidence must be explained, not averaged away.

## Sources behind the method

- [OpenAI Codex code review](https://learn.chatgpt.com/docs/code-review): use an exact Git-backed scope and return prioritized findings without modifying the tree.
- [OpenAI custom review rules](https://learn.chatgpt.com/blog/custom-code-review-rules-for-codex): keep rules consequential, scoped, durable and paired with a safe path; evaluate coverage, restraint, retention and actionability.
- [OpenAI security diff review](https://learn.chatgpt.com/use-cases/scan-code-changes-for-security): focus on changed code plus directly supporting files and validate attack-path evidence before remediation.
- [Google engineering review guidance](https://google.github.io/eng-practices/review/reviewer/looking-for.html): review design, functionality, edge cases, concurrency, tests, complexity, documentation and every relevant line.
- [OWASP Secure Code Review](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Code_Review_Cheat_Sheet.html): combine diff-based review, data-flow analysis, threat-based review, business logic, trust boundaries and automation.
