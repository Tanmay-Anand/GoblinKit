# GoblinKit — Explanation

> **Status: design complete, implementation not started.** The README says so directly. Two files —
> `ARCHITECTURE.md` (75 KB) and `README.md` (15 KB). No `packages/`, no TypeScript, no code. The
> architecture document is described as "the specification of record."
>
> This is a **product and platform design** rather than a procedure, and it's unusually rigorous —
> the prior-art section alone works through n8n, Zapier, Make, Node-RED, Temporal, Airflow,
> Langflow, Dify and React Flow before proposing anything.
>
> **What I checked:** the two classic event-sourcing hazards. One is handled well; the other is the
> load-bearing gap in the document. See §11.

---

## 1. The One-Liner

GoblinKit is a tool where you draw a flowchart of things you want done automatically — fetch this,
check that, send a message — and it runs it reliably, remembers exactly what happened, and can pick
up where it left off if the machine running it dies.

---

## 2. The Problem

### The product problem

Workflow automation — Zapier, n8n, Make — lets non-programmers wire services together visually.
"When someone signs up, look them up in the CRM, and if they're worth more than £1000/month, post
to Slack." The category is enormous and well served.

### The actual problem being solved

Which is why the framing matters: this isn't "another n8n." It's **two things deliberately kept
separate**:

- **A product** — the visual automation app.
- **A kit** — layered packages where the engine, graph semantics, and node SDK know nothing about
  *this* product. The next workflow-shaped thing you build (an AI agent builder, an ETL designer, an
  approval router, a CI pipeline editor) reuses the core and replaces only the node packs and UI.

The design question stated as governing every decision:

> **Does this stay true when the node set, the UI, and the execution backend all change?**

### What existing tools get wrong, in the design's view

| | Typical approach | GoblinKit |
|---|---|---|
| **Scheduling** | An imperative loop over a mutable execution stack | A **pure reducer** — no I/O in the decision layer |
| **Durability** | State blob updated as you go | **Append-only journal is the truth**; state is a fold |
| **Node definition** | UI metadata and server code in one artifact | **Manifest (data) / executor (code) split** — the browser never gets server code |
| **Loops** | Arbitrary cycles, or none at all | **Scoped cycles** with termination bounds and per-iteration addressing |
| **Waiting** | A worker sits blocked | A run waiting three weeks for approval costs **one database row** |
| **Idempotency** | Each node author's problem | **Platform-derived** step keys, forwarded upstream |
| **User code** | `node:vm` (which is not a sandbox) | **QuickJS-WASM** with fuel limits |
| **Versioning** | Added once it hurts | `typeVersion` + migrations mandatory from node #1 |

The `node:vm` row is worth pausing on — it's a correct and load-bearing criticism. Node's `vm`
module is explicitly documented as *not* a security mechanism, and plenty of products use it as one.

---

## 3. How It Works — Plain English

### The analogy

Think of a **very disciplined kitchen**.

The head chef never touches a pan. Their entire job is to look at the current state of the kitchen —
what's prepped, what's in the oven, what just came back from the pass — and write the next set of
tickets: *"start the sauce," "put the fish on in four minutes," "wait for the delivery."* They hand
the tickets out and write every decision in a logbook.

The cooks do the actual work. They read a ticket, do it, and report back: *done, here's the result*
— or *burnt it*. That report goes to the chef, who reads it and writes the next tickets.

Two properties fall out of this arrangement, and they're the whole design.

**The chef can be replaced mid-service.** If they collapse, a new chef reads the logbook from the
start and arrives at exactly the current state of the kitchen — because the logbook contains every
decision and every report. Nothing was held in their head.

**You can rewind the service.** Want to know what the kitchen looked like just before the fish
burned? Read the logbook up to that line. It isn't an investigation, it's a bookmark.

And one rule makes both work: **the chef must never look at the clock on the wall or guess.** If two
different chefs reading the same logbook could reach different conclusions — because one glanced at
the time — the logbook stops being authoritative. So when a decision needs the time, the time is
*handed to the chef on the ticket*, and written down.

### Tracing one run

Someone signs up on a website. The workflow: fetch their CRM record, check if they're worth more
than £1000/month, and if so post to Slack.

1. **A webhook fires.** The request hits the ingress, which deduplicates by idempotency key — if the
   same signup is delivered twice, the second one starts nothing.
2. **The engine is handed a `RunStarted` event.** It computes: nothing depends on anything yet, so
   the first node is ready. It returns a *description* — `InvokeNode: fetch the CRM record` — plus
   journal entries. It performs no HTTP call.
3. **The driver does the work.** It takes the command, sends it to a worker, and the worker's HTTP
   node makes the actual request — through a platform-provided client, so rate limits, egress rules,
   tracing, and secret redaction are enforced whether or not the node author thought about them.
4. **The worker reports back** with `NodeSucceeded` and the response data. Written to the journal.
5. **The engine advances again.** The `if` node evaluates `mrr > 1000`. Here's the elegant bit:
   there's no "branch" concept. The engine just marks the `false` edge **pruned** and the `true`
   edge **delivered**. Anything downstream of a pruned edge simply never becomes ready.
6. **Slack node runs**, reports success, run completes.
7. **Throughout, the journal accumulated every event.** The run's current state was never the
   authoritative thing — it's a summary you can always rebuild by replaying the journal.

And if the machine dies at step 4? A different worker picks up the run, replays the journal, arrives
at exactly the state before the crash, and continues. There's no special recovery code, because
recovery is just the normal way state is computed.

---

## 4. How It Works — Technical

### 4.1 The layering

```
apps/
  web/          editor + console
  api/          HTTP · webhook ingress · scheduler
  worker/       execution workers
                       │
packages/              │
  editor/       React Flow canvas, document store, schema-driven forms
  persistence/  Postgres repos · journal · blobs · outbox
  drivers-queue/ pg-boss/BullMQ · leases · heartbeats · recovery
  drivers-inprocess/ single-process (tests, CLI, local dev)
  nodes-core/   triggers · http · if/switch/merge · transform · code · loops · wait
  sandbox/      QuickJS-WASM · isolated-vm
  expressions/  {{ }} parser + evaluator (no eval)
─────────────────────── THE REUSE BOUNDARY ───────────────────────
  node-sdk/     defineManifest · defineExecutor · ctx · harness
  runtime/      advance() · state · commands · events · policies   ← the engine
  graph/        topo sort · cycles · scopes · affected-subgraph
  spec/         document types · zod · validation · migrations     ← no deps
```

> "`spec` + `graph` + `runtime` + `node-sdk` is the kit — no database, no HTTP, no Redis, no React.
> **A CI rule fails the build if `runtime` imports `pg`; this is enforced, not aspirational.**"

That last clause is the difference between a layering diagram and a layering *constraint*.

### 4.2 The document

The only contract shared between editor, engine, and storage is a serializable JSON document. It
references no runtime type, React component, or database row.

```jsonc
{ "id": "n2", "type": "core.http.request", "typeVersion": 2,
  "config": { "method": "GET", "url": "https://api.crm.test/a/{{ $json.accountId }}" },
  "credentials": { "httpAuth": { "id": "cred_9f2", "type": "httpAuth" } },
  "policy": { "retry": { "maxAttempts": 5, "backoff": "exponential" } },
  "ui": { "position": { "x": 240, "y": 0 } } }
```

Note: no secrets — only a `CredentialRef`. And presentation is quarantined under `ui`, so **moving a
node produces an obviously non-semantic diff** and a headless consumer ignores it entirely. Small
decision, large payoff for review and version control.

### 4.3 The central abstraction

```ts
/** Pure. No I/O, no clock, no randomness, no async. */
export function advance(
  state: RunState,
  event: RunEvent,
  ctx: SchedulerContext,
): Transition;

export interface SchedulerContext {
  readonly graph: CompiledGraph;
  readonly policies: ResolvedPolicies;
  readonly now: Timestamp;                   // supplied by the driver, never read from Date
  readonly newId: (kind: IdKind) => string;  // seeded, deterministic per run
}

export interface Transition {
  readonly state: RunState;
  readonly commands: readonly Command[];      // side effects for the driver
  readonly journal: readonly JournalEntry[];  // facts to append atomically with state
}
```

```
        ┌──────────────── Driver (impure) ─────────────────┐
        │  executes commands · owns clock, network, queue  │
        └──────┬────────────────────────────▲──────────────┘
               │ commands            events │
        ┌──────▼────────────────────────────┴──────────────┐
        │  advance(state, event, ctx)                       │
        │              pure · deterministic                 │
        └───────────────────────────────────────────────────┘
```

Commands are an 8-variant union: `InvokeNode`, `ScheduleTimer`, `CancelTimer`, `AwaitSignal`,
`StartSubRun`, `CancelInvocation`, `CompleteRun`, `EmitMetric`. Events are a 9-variant union:
`RunStarted`, `NodeSucceeded`, `NodeFailed`, `NodeProgress`, `TimerFired`, `SignalReceived`,
`SubRunFinished`, `CancelRequested`, `LeaseLost`.

### 4.4 Edges as the branching mechanism

An edge is `Pending`, `Delivered(envelope)`, or `Pruned`. That's it — and:

> "Conditional branching is nothing more than pruning — the engine has no special 'branch' concept."

An `if` node delivers on one output port and prunes the other. Downstream nodes never become ready.
A three-way `switch` prunes two of three. Error routing prunes the success path. One mechanism, no
special cases in the scheduler.

### 4.5 Scoped cycles

Cycles are legal **only** through an edge whose target is a `ScopeStart`; anything else is a
validation error (`UNSCOPED_CYCLE`) with a quick-fix offering to insert a loop scope.

```
      ┌───────────────── loop back ─────────────────┐
      ▼                                             │
 [ScopeStart:loop1] ─▶ [transform] ─▶ [http] ─▶ [ScopeEnd:loop1] ─▶ [summary]
```

Three things this buys that arbitrary cycles can't:

1. **Termination bounds.** Every scope carries `maxIterations` and `maxDuration`. Runaway loops are
   *structurally impossible*, not discouraged.
2. **Addressable node runs.** Keyed by `(nodeId, scopePath)` where scopePath is `loop1[3]/inner[0]`.
   Every iteration is individually addressable in the journal, UI and logs. Engines keying by
   `nodeId` alone lose per-iteration history entirely.
3. **Legible visuals.** A scope renders as a container, so users see the loop rather than inferring
   it from a back-edge.

### 4.6 Manifest / executor split

```ts
// manifest.ts — pure data, browser-safe
export const manifest = defineManifest({
  type: 'slack.message.send', version: 1,
  executionMode: 'perItem',
  ports: { inputs: [{ id: 'main', required: true, join: 'all' }],
           outputs: [{ id: 'main' }, { id: 'error' }] },
  credentials: [{ type: 'slackOAuth2', required: true }],
  config: { schema: z.object({ channel: expression(z.string()),
                               text: expression(z.string()) }), /* … */ },
});
```

```ts
// executor.ts — server only
export const executor = defineExecutor(manifest, async (ctx) => {
  const res = await ctx.http.request({ /* … */ });   // SSRF-guarded, metered, traced
  if (!res.ok) throw ctx.error.fromHttp(res);         // classified → retry policy applies
  return ctx.emit.main([{ data: res.json }]);
});
```

The editor renders the entire config form from the manifest — **no per-node UI code**. And the
executor reaches the network only through `ctx.http`, so platform concerns are enforced structurally
rather than by node-author discipline.

### 4.7 Step-level idempotency

```
idempotencyKey = base64url(sha256(runId ‖ nodeId ‖ scopePath ‖ attemptGroup ‖ inputHash))
```

Stable across retries of the same logical step, different across genuinely different steps.
Forwarded as `Idempotency-Key` to providers that support it.

> "A retried 'create charge' node does not double-charge — **the platform makes this correct rather
> than each node author remembering it.** This is the primitive that turns at-least-once execution
> into effectively-once business behaviour."

The `attemptGroup` component is the subtle part: automatic retries share a key; a deliberate operator
re-run gets a fresh one, because that genuinely *is* a new charge.

---

## 5. The Core Concept: Decide Purely, Execute Impurely

Everything reusable follows from one function. Seven moves.

### 5.1 What a workflow engine normally looks like

The natural implementation is an imperative loop:

```
while (there is work) {
  node = pickNextReadyNode()
  result = await node.execute()      // ← HTTP call happens right here
  updateState(result)
  if (shouldRetry(result)) { await sleep(backoff); continue }
  persistState()
}
```

This works, and it has four properties that hurt:

- **Untestable without mocks.** Exercising the scheduler means stubbing HTTP, timers, and the clock.
- **Recovery is bespoke.** A crash mid-loop leaves state that must be *repaired*, and repair logic
  is separate code with its own bugs — exercised only during incidents, which is when you least want
  to discover them.
- **Backend-coupled.** Moving to a queue means rewriting the loop.
- **Non-reproducible.** "Why did this run branch that way?" cannot be answered by running it again,
  because the world moved on.

### 5.2 The split

Separate **deciding** from **doing**:

```
advance(state, event, ctx) → { state, commands, journal }
```

The engine never performs a side effect. It *describes* them. `InvokeNode` isn't a call — it's a
value saying "someone should invoke this node." A driver performs it and reports back as an event.

This is the *functional core, imperative shell* pattern. What makes it interesting here is what
falls out at scale.

### 5.3 Making "pure" actually work

There's an obvious objection: a scheduler genuinely needs the current time (to set timer deadlines)
and needs to generate IDs (for node runs). Both are impure. A dogmatic purity rule would make the
function unimplementable.

The design's answer is the important detail, and it's why `SchedulerContext` exists:

```ts
readonly now: Timestamp;                   // supplied by the driver, never read from Date
readonly newId: (kind: IdKind) => string;  // seeded, deterministic per run
```

**The impure inputs are injected rather than banned.** `advance` still can't call `Date.now()` or
`Math.random()` — but it can *receive* a timestamp and a seeded generator. Given the same
`(state, event, ctx)` it always produces the same `Transition`.

That's the move that turns purity from a slogan into something implementable. It also relocates the
responsibility: reproducibility now depends on the *driver* supplying the same `ctx` on a replay —
which is a real contract, and §11 is about whether it's specified.

### 5.4 The journal, and state as a fold

The second half of the idea. Every transition emits journal entries, appended atomically with the
state. The journal is authoritative; state is a **cache**:

```
state = journal.reduce(apply, initial)
```

Read that as a definition rather than an optimisation. The run's state isn't a thing that's *kept
up to date* — it's a thing that's *computed from history*, and could be thrown away and recomputed
at any moment.

Postgres makes the atomicity work: `runs` (folded state snapshot), `run_events` (the append-only
journal, `(run_id, seq)` primary key), and `outbox` (transactional command dispatch) all commit in
**one transaction**. That's what kills the dual-write bug class — you cannot have persisted the
state but lost the command, or dispatched a command for a state you didn't save.

### 5.5 What falls out for free

This is the payoff, and the reason to accept the indirection:

| Capability | Why it's free |
|---|---|
| **Crash recovery** | `state = journal.reduce(apply)`. A dead worker's run is picked up by folding. **No bespoke recovery path** — recovery is just how state is always computed. |
| **Time-travel debugging** | Fold to entry *k*. "State right before node X failed" is a slice, not an investigation. |
| **Deterministic tests** | Golden files: feed `(document, events)`, diff the emitted command stream. Engine regressions caught by CI diff. |
| **Backend portability** | In-process, queue-backed, and Temporal drivers consume identical commands. |
| **Production replay** | Export a run's journal, replay locally, get identical behaviour. |
| **Safe concurrency** | Commands computed under a single-writer lease; the pure core has no shared mutable state to race on. |
| **"Copy as failing test case"** | A support ticket exports as `(document, journal)` — a golden-file fixture in one click. |

The last row is the one I'd put on a whiteboard. It's not a feature anyone designed; it's a
*consequence*. When the engine is a pure function of a recorded input sequence, a bug report and a
regression test are the same artefact.

### 5.6 Why the *step* boundary, not the *code* boundary

Temporal — the reference system for durable execution — replays your workflow *code* from the
beginning on recovery, skipping completed activities. That requires the workflow definition to be
deterministic, or replay fails on a non-determinism mismatch.

The design explicitly rejects this, and the reasoning is sound:

> "Determinism cannot be imposed on user-authored graphs, and users edit workflows that have runs
> in flight."

You cannot tell a non-programmer drawing boxes on a canvas that their workflow must be
deterministic. And a Zapier-style product lets people *edit* an automation while instances of it are
mid-flight — which breaks code replay outright.

So durability is checkpointed at the **step** boundary. Each node run is recorded; recovery resumes
from the last recorded step rather than re-executing from the top. Same durability guarantee, no
determinism constraint on the user's graph.

The design's own summary: *"Temporal's insight applied at the step boundary rather than the code
boundary."* And because `advance` is pure, a Temporal driver remains *possible* later — a Temporal
workflow whose body is the `advance` loop is deterministic by construction. That optionality is the
payoff of the purity decision.

### 5.7 The dependency worth naming

Everything in §5.5 depends on one claim: **folding the journal reproduces the state.**

That holds if the fold function is fixed. `advance` is code, and code changes. Fold Monday's journal
through Wednesday's `advance` and you may get a different answer than the run actually had.

This is the classic hard problem of event sourcing, and §11 is where I check whether the design
addresses it.

---

## 6. Key Decisions & Tradeoffs

**Pure reducer over imperative loop.** *Cost:* significant indirection — you cannot read a single
function and see the workflow execute; you read a reducer and a driver and hold both. Debugging a
"why didn't this node run" question means reasoning about edge states rather than stepping through
a call stack.

**Journal as truth, state as fold.** *Cost:* journals grow fast. The design plans for it from day
one — hot journal in Postgres for N days, then compaction (keep node run headers and errors, move
envelopes to blob storage), then deletion per tenant policy. *"Building this after launch means
building it under load, which is the worst time."* That's the right instinct.

**Step-level durability rather than code replay.** Covered in §5.6. *Cost:* you don't get Temporal's
ability to resume mid-function; the granularity of recovery is a whole node.

**Manifest/executor split.** *Cost:* two artifacts per node and a discipline to maintain. *Payoff:*
the browser never receives server code, and the editor needs zero per-node UI.

**Scoped cycles rather than arbitrary ones.** *Cost:* some graph shapes are unexpressible, and users
must learn what a scope is. *Payoff:* termination is structural, and per-iteration addressing exists.

**QuickJS-WASM for user code.** *Alternative:* `node:vm` (not a sandbox), `isolated-vm` (a real
boundary, heavier). *Why:* genuine isolation plus **deterministic fuel limits** — you can bound CPU
in instructions rather than wall-clock, which is what you actually want for multi-tenant fairness.
*Cost:* a restricted JS environment; not everything users expect will work.

**Postgres for journal + state + outbox in one transaction.** *Why:* kills the dual-write bug class.
*Cost:* Postgres becomes the throughput ceiling; `pg-boss → BullMQ behind a port` is the stated
escape hatch.

**Multi-tenancy from the start.** Principle 7: *"there is no 'add tenancy later' path."* Row-level
security by `tenant_id` on every table. Correct, and expensive early.

**Everything versioned.** `schemaVersion` on documents, `typeVersion` on nodes with mandatory
migrations, `workflow_versions` immutable so runs pin a version and editing never changes a running
workflow. Exemplary — with one omission (§11).

---

## 7. Rubber Duck Walkthrough

*Reading the design and arguing with it.*

"Start at `advance`. Pure function, three inputs, returns state plus commands plus journal entries.
The engine describes effects instead of performing them.

First thing I want to check is whether 'pure' is real or aspirational, because that word gets used
loosely. A scheduler needs the clock — timers have deadlines. And it needs to mint node run IDs. Both
impure.

The answer is `SchedulerContext`: `now` is supplied by the driver, `newId` is seeded. So the impurity
is *injected* rather than performed. That's the right technique and it's what makes the whole thing
implementable. Good.

But it moves the problem rather than eliminating it. `advance` is deterministic *given ctx*.
Reproducing a run requires reproducing `ctx` — same `now`, same seed, same graph. So the replay
guarantee is really a contract on the **driver**, not a property of the engine.

Line 529 says: 'Export a run's journal from prod, replay locally, get identical behaviour — because
the decision layer has no ambient inputs.' The decision layer doesn't, but `ctx` is an ambient input
that's been made explicit. If my local driver supplies `now = Date.now()` I diverge on the first
timer. So `now` and the ID seed need to be *in the journal*, and a replaying driver needs to read
them back out.

Is that specified? Let me look at the journal entry type.

`JournalEntry` appears… twice in 90 KB. Once in the README's `advance` signature and once in the
ARCHITECTURE's. It is never defined. `Command` gets a full eight-variant discriminated union.
`RunEvent` gets nine variants. `RunState` gets an interface with field types. The thing declared to
*be the truth* — principle 3, 'the journal is the truth' — gets a name and a trailing comment.

The `run_events` table exists, labelled '**append-only journal** · `(run_id, seq)` primary key · the
truth' — and lists no columns.

That's a real hole, and it's precisely at the load-bearing point. Every capability in §7.4 is a
claim about what you can do with the journal, and the journal has no schema.

Now the second thing, which I think is bigger.

The journal is truth; state is `journal.reduce(apply)`. Fine — while `apply` is fixed. But `apply` is
`advance`, and `advance` is code I will change. I ship a scheduling bugfix on Tuesday. On Wednesday a
worker crashes on a run that started Monday. Recovery folds Monday's journal through Tuesday's
reducer.

Two outcomes, both bad. If the fix changed behaviour, the recovered state differs from the state the
run actually had — the run silently changes its mind about history. If the fix changed the *shape* of
what state holds, the fold may not even complete.

Snapshots make this worse rather than better, incidentally. §9 says long-running runs snapshot every
K entries so recovery is 'snapshot + tail'. So a run recovered after a deploy is a snapshot computed
under the old reducer, extended by a tail computed under the new one. A hybrid state that never
existed under either.

Does the doc handle it? It handles versioning *everywhere else*, meticulously — `schemaVersion` on
documents, `typeVersion` with mandatory migrations on nodes, `workflow_versions` immutable so runs
pin a document version and editing can't disturb an in-flight run. Principle 6 is literally
'Everything is versioned and migrated.'

But there's no `engineVersion` on a run. Nothing says a run is pinned to the `advance` implementation
it started under. No journal migration story. I grepped for 'engine version', 'reducer version',
'journal version' — nothing.

So the design applies exactly the right discipline one layer up, at the document and node level, and
doesn't apply it to itself. Which is understandable — the reducer feels like *infrastructure* rather
than *content* — and it's the thing most likely to bite in production, because it only manifests on
deploy-plus-crash, which is rare enough to reach production and common enough to happen.

Moving on to things I like.

Branching as edge pruning is lovely. No `branch` concept in the scheduler at all — an `if` delivers
one port and prunes the other, and readiness does the rest. Switch, error routing, skip: all the same
mechanism. That's a genuine reduction rather than a rename.

Scoped cycles. Loops only back into a `ScopeStart`, so every loop has `maxIterations` and
`maxDuration` structurally. And the scopePath `loop1[3]/inner[0]` means iteration 3 of the outer loop
is individually addressable in the journal and the UI. Anyone who has debugged a loop in a tool that
keys by node ID knows exactly what that's worth.

The idempotency key includes `attemptGroup`, which I initially read past. It's the difference between
'the platform retried' and 'a human clicked re-run' — the first must reuse the key so Stripe
deduplicates, the second must not, because it genuinely is a new charge. Subtle and correct.

`AwaitSignal` meaning a three-week approval costs one database row rather than a blocked worker —
that's the thing that separates a real durable engine from a job runner.

One more thing I'd want. The `ui` key quarantining position data so moving a node is an obviously
non-semantic diff. Small, and anyone who has reviewed a workflow diff where a drag reordered the
whole JSON will appreciate it."

---

## 8. Prerequisite Concepts

**Workflow automation / node-based programming.** Building a program by wiring boxes together on a
canvas rather than writing text. Each box (node) does one thing; connections (edges) carry data.

**DAG (Directed Acyclic Graph).** Nodes connected by one-way edges with no cycles — so there's a
valid execution order. GoblinKit's twist is that it's a DAG *of scopes*, with cycles permitted only
inside a scope.

**Pure function.** Same inputs always produce the same output, with no side effects — no network, no
clock, no randomness, no mutation of anything outside itself. Trivially testable and trivially
replayable.

**Functional core, imperative shell.** An architecture where decision logic is a pure function and
all I/O lives in a thin outer layer. The core says *what should happen*; the shell makes it happen.

**Reducer / fold.** A function `(state, event) → state`. Applying it across a sequence of events
("folding") reconstructs the final state from history. `Array.reduce` is the same idea.

**Event sourcing.** Storing the sequence of events that happened rather than the current state, and
deriving state by folding. Gives you history, audit, and time-travel for free — and imposes the
schema-evolution problem in §11.

**Idempotency.** An operation safe to perform more than once with the same result. Critical in
distributed systems, where "did that request arrive?" is often unanswerable, so retrying is the only
option.

**Idempotency key.** A caller-supplied identifier letting the receiver recognise a retry and return
the original result instead of acting again. Stripe and others support this on their APIs.

**At-least-once vs exactly-once.** Distributed systems can generally guarantee a message is delivered
*at least* once (retry until acknowledged), not exactly once. Idempotency is how you turn
at-least-once delivery into effectively-once *behaviour*.

**Outbox pattern.** Writing a to-be-dispatched message into the same database transaction as the
state change, then having a separate process drain it. Prevents the dual-write bug where you commit
the state but crash before publishing (or vice versa).

**Lease / heartbeat.** A worker claims a run for a bounded time and periodically renews. If it dies,
the lease expires and another worker takes over — which is what makes crash recovery automatic.

**Sandboxing and `node:vm`.** Running untrusted code with restricted capabilities. Node's built-in
`vm` module is explicitly *not* a security boundary — code inside can escape to the host. **QuickJS
compiled to WebAssembly** is a genuine boundary, and supports *fuel limits*: bounding execution by
instruction count rather than wall-clock, which is deterministic.

**SSRF (Server-Side Request Forgery).** Tricking a server into making requests on your behalf — e.g.
to internal addresses. Why `ctx.http` is a guarded platform client rather than raw `fetch`.

**Envelope encryption.** Encrypting data with a per-record key (DEK), then encrypting that key with a
master key (KMS). Rotating the master key means re-encrypting only the small keys, not all the data.

---

## 9. Explain It To Others

### 30 seconds — a non-technical friend

"You know those tools where you draw a flowchart — 'when someone fills in this form, look them up,
and if they're a big customer, message the sales team'? This is one of those, built so it's
genuinely reliable. It writes down every single thing that happens as it goes, so if the computer
running it crashes halfway through, another one reads the notes and carries on from exactly the
right place. And you can rewind to any moment and see what the state was — which is normally very
hard and here comes free."

### 2 minutes — a developer

"It's a node-based workflow automation platform, designed so the engine underneath is reusable for
any workflow-shaped product.

The whole thing follows from one function:

```ts
advance(state, event, ctx) → { state, commands, journal }
```

Pure. No I/O, no clock, no randomness. The engine never performs side effects — it *describes* them.
`InvokeNode` is a value, not a call. A driver executes commands and reports back as events.

The clever bit is how purity survives contact with reality: the scheduler needs the time and needs
to mint IDs, so `now` and a seeded `newId` are **injected** via a context object rather than banned.
Purity becomes implementable instead of aspirational.

Second half: the append-only journal is the truth and state is a fold — `state =
journal.reduce(apply)`. Not an optimisation, a definition.

Together those give you crash recovery, time-travel debugging, deterministic golden-file tests, and
backend portability *as consequences rather than features*. Recovery isn't special code — folding the
journal is how state is always computed, so a dead worker's run is picked up the ordinary way. My
favourite consequence is 'copy as failing test case': a support ticket exports as `(document,
journal)`, which is exactly a golden-file fixture. Nobody designed that; it falls out.

It's Temporal's insight moved from the *code* boundary to the *step* boundary — deliberately,
because you can't impose determinism on graphs that non-programmers author and edit while runs are
in flight.

A couple of smaller things I like. Branching isn't a concept: an `if` node just marks one edge
delivered and the other pruned, and readiness does the rest — so switch, error routing, and skip are
all one mechanism. And cycles are only legal back into a scope, which makes `maxIterations`
structural and gives every loop iteration an address like `loop1[3]/enrich`."

### 5 minutes — an interviewer who will push back

Lead with the 2-minute version, then:

"**Not built** — the README says design complete, implementation not started. 90 KB of specification.

**The decision I'd defend** is choosing the step boundary over the code boundary for durability.
Temporal replays your workflow code from the top and requires determinism. That's the right call for
code developers write; it's the wrong call here for two concrete reasons — you cannot tell a
non-programmer that the boxes they drew must be deterministic, and this product lets people edit
workflows that have runs in flight, which breaks code replay outright. Step checkpointing gets the
same durability without either constraint. And because the scheduler is *still* pure, a Temporal
driver stays possible later, which is the option value of the purity decision.

**The gap I found, and I'd raise it myself.** The design versions everything meticulously —
documents carry `schemaVersion`, node types carry `typeVersion` with mandatory migrations, workflow
versions are immutable so a run pins one and editing can't disturb it. Principle 6 is 'Everything is
versioned and migrated.'

But there's no version on the *reducer*. The journal is truth and state is `journal.reduce(apply)` —
and `apply` is `advance`, which is code that will change. Ship a scheduling fix, then recover a
crashed run that started before the deploy, and you fold an old journal through a new reducer. The
state you recover isn't the state the run had. Snapshots make it worse: 'snapshot + tail' means a
snapshot computed under the old reducer extended by a tail computed under the new one — a state that
never existed under either version.

That's the classic hard problem of event sourcing, and it's the one thing this architecture most
depends on. The fix is the discipline they already applied one layer up: put `engineVersion` on the
run, pin it, and write journal migrations when the reducer changes.

**And a smaller one.** `JournalEntry` appears twice in 90 KB, both times as a type reference in the
`advance` signature. It's never defined. `Command` gets eight variants, `RunEvent` gets nine,
`RunState` gets an interface — and the thing declared to be the truth gets a name."

---

## 10. Questions You'd Be Asked

**Q: Why make the scheduler pure? Isn't that just style?**
No — six capabilities fall out of it that would otherwise each need building. Crash recovery is
`journal.reduce(apply)` rather than bespoke repair code. Time-travel debugging is folding to entry
*k*. Tests are golden files diffing a command stream, no mocks. Backend portability is free because
in-process and queue drivers consume identical commands. And "copy as failing test case" — turning a
support ticket into a regression fixture in one click — is a consequence nobody designed. The
indirection is real; you buy six things with it.

**Q: A scheduler needs the clock. How is it pure?**
By injecting rather than performing. `SchedulerContext` carries `now` (driver-supplied, "never read
from `Date`") and `newId` (seeded per run). The function can *receive* impure values but never
*obtain* them, so `(state, event, ctx)` always yields the same transition. That's what makes purity
implementable here rather than a slogan — but note it relocates the reproducibility guarantee onto
the driver, which must supply the same `ctx` on a replay.

**Q: Why not just use Temporal?**
Temporal replays workflow *code* from the beginning and therefore requires the workflow to be
deterministic. Two things break that here. You can't impose determinism on graphs authored by
non-programmers dragging boxes. And this product lets users edit a workflow while instances are
mid-flight, which invalidates code replay entirely. So durability is checkpointed at the step
boundary instead. The design keeps a Temporal *driver* possible later precisely because `advance`
is pure — the option costs nothing to preserve.

**Q: How does conditional branching work?**
There isn't a branching concept. Every edge is `Pending`, `Delivered`, or `Pruned`. An `if` node
delivers its `true` port and prunes its `false` port; nodes downstream of a pruned edge never become
ready. Switch, error routing, and skipping all reduce to the same mechanism, so the scheduler has no
special cases for control flow. That's a genuine simplification, not a rename.

**Q: Why restrict loops to scopes?**
Three concrete gains. Termination becomes structural — every scope carries `maxIterations` and
`maxDuration`, so a runaway loop is impossible rather than discouraged. Node runs become addressable
by `(nodeId, scopePath)` like `loop1[3]/enrich`, so per-iteration history exists in the journal, UI
and logs — engines keyed by node ID alone lose that entirely. And the loop renders as a visible
container instead of a back-edge users have to infer. The cost is that some graph shapes are
unexpressible.

**Q: What stops a retried node from charging a customer twice?**
A platform-derived idempotency key: `sha256(runId ‖ nodeId ‖ scopePath ‖ attemptGroup ‖ inputHash)`,
forwarded upstream as `Idempotency-Key`. Stable across retries of the same logical step, different
across genuinely different steps. The `attemptGroup` component is the subtle piece — an automatic
retry reuses the key so the provider deduplicates, but an operator clicking re-run gets a fresh one,
because that is genuinely a new charge. The point is that this is platform behaviour, not something
each node author must remember.

**Q: What happens when a run waits three weeks for an approval?**
Nothing occupies a worker. The engine emits `AwaitSignal` and the run's state is a row; when the
signal arrives it becomes a `SignalReceived` event and the run advances. That's the difference
between a durable execution engine and a job runner, and it's only possible because the engine
describes waiting rather than performing it.

**Q: Where does this fall over?**
Reducer evolution. Everything rests on "folding the journal reproduces the state," which holds only
while the fold function is fixed. `advance` will change. Recovering a pre-deploy run after a
scheduling fix folds an old journal through a new reducer, and snapshots compound it — a snapshot
from the old reducer extended by a tail from the new one. The design versions documents and node
types rigorously and doesn't version the engine. That's the gap I'd close before writing Stage 3.

**Q: Isn't a pure reducer harder to debug?**
Yes, and that's the honest cost. You can't step through a call stack and watch the workflow execute —
you read a reducer and a driver and hold both in your head, and "why didn't this node run" becomes
reasoning about edge states rather than following control flow. The mitigation is that the same
property making it hard to trace makes it trivial to *reproduce*: you can replay the exact event
sequence locally instead of trying to catch it live.

---

## 11. Weak Points

### Gaps in the design

- **No reducer/engine versioning — the load-bearing gap.** Principle 3 makes the journal the truth
  and state a fold; principle 6 says *"everything is versioned and migrated."* Documents carry
  `schemaVersion`, node types carry `typeVersion` with mandatory migrations, and
  `workflow_versions` are immutable so a run pins one. But nothing versions `advance` itself. Fold a
  pre-deploy journal through a post-deploy reducer and the recovered state may differ from the state
  the run actually had — or fail to fold at all if the state shape changed. **Snapshots amplify
  this**: "snapshot + tail" recovery after a deploy produces a snapshot computed under the old
  reducer extended by a tail under the new one, a hybrid that existed under neither. I searched for
  `engine version`, `reducer version`, and `journal version` — no hits. The fix is the discipline
  already applied one layer up: `engineVersion` on the run, pinned, with journal migrations.

- **`JournalEntry` is never defined.** It appears exactly twice across 90 KB, both times as a type
  reference in the `advance` signature. `Command` gets a full eight-variant union, `RunEvent` nine,
  `RunState` a typed interface. The `run_events` table is labelled *"append-only journal · the
  truth"* and lists no columns. The most load-bearing type in the architecture is the only major one
  without a shape.

- **Replay reproducibility is a driver contract that isn't stated.** §7.4 claims *"export a run's
  journal from prod, replay locally, get identical behaviour — because the decision layer has no
  ambient inputs."* True of `advance`, but `ctx` carries `now` and a seeded `newId`, and those *are*
  ambient — just made explicit. Reproducing a run requires the replaying driver to supply the
  recorded `now` and the same seed. `UNCLEAR:` whether those are journaled, and nothing specifies the
  contract a driver must honour to make replay valid. Related to the point above: this is exactly
  the sort of thing a defined `JournalEntry` would settle.

- **`inputHash` in the idempotency key interacts oddly with replay.** The key includes a hash of the
  node's input. If an upstream node's output contains anything varying — a timestamp, a request ID —
  then a *re-run* produces a different key, which is correct. But it means the key is only as stable
  as upstream determinism, and nothing discusses which inputs are hashed or whether volatile fields
  are excluded.

- **Compensation is deferred but its interaction with idempotency isn't considered.** §11.7 keeps the
  door open for sagas — `compensate` on manifests, `compensateOnFailure` on scopes, reverse-order
  invocation. `UNCLEAR:` a compensation invocation is a new step and would derive a new idempotency
  key, which is probably right, but "undo the charge you made under key X" usually needs to
  *reference* X. Worth settling before the reducer branch is written.

- **The `runs` table holds a "folded state snapshot" and `run_events` holds the journal.** Both are
  the truth in different senses — the design says the snapshot is a cache (P3), which is correct.
  `UNCLEAR:` no stated mechanism detects or repairs snapshot/journal divergence, which is precisely
  what a reducer change would produce.

### Risks in building it

- **Seven stages, and the honest read is that stages 1–3 alone are a substantial engine.** Spec,
  graph, runtime, node SDK, journal, snapshots, outbox, queue driver with leases and heartbeats and
  a recovery sweeper, plus a chaos test asserting exactly-once under worker kills. That's the kit,
  and it's the hard part.

- **The category is brutally competitive.** n8n, Zapier, Make, and Pipedream are mature and
  well-funded. The design's answer is that the *kit* is the product and the automation app is one
  consumer of it — which is a real differentiator but only if a second product actually gets built
  on it. Until then it's an unusually well-architected n8n competitor.

- **Node packs are the real moat and the real cost.** A workflow tool's value is how many services
  it integrates. n8n has hundreds. The manifest/executor split makes each node cheap to write; the
  quantity is still the work, and none of the seven stages is "write 200 integrations."

- **Purity is enforced by discipline plus one CI rule.** The rule that `runtime` may not import `pg`
  is excellent and catches the obvious violation. It does not catch `Date.now()` inside `advance`.
  A lint rule banning ambient clock/random access in the runtime package would be the natural
  companion, and isn't mentioned.

- **Nothing is executable.** No `packages/`, no code.

### What's genuinely strong

The prior-art section is the best I've seen in a design document — nine systems studied with an
explicit take/reject for each, and the criticisms are specific and correct (Node-RED's mutable `msg`
breaking provenance; `node:vm` not being a sandbox; Temporal's determinism requirement being
incompatible with user-authored, mid-flight-editable graphs). The `SchedulerContext` injection of
`now` and `newId` is the detail that makes purity real rather than rhetorical, and most designs that
claim purity get exactly this wrong. Branching-as-edge-pruning is a genuine conceptual reduction.
The `attemptGroup` component of the idempotency key distinguishes automatic retry from operator
re-run, which is the kind of thing you only get right after being burned. Quarantining position data
under `ui` so a drag produces a non-semantic diff is a small decision with disproportionate payoff.
And the retention plan existing *before* launch — *"building this after launch means building it
under load, which is the worst time"* — is the correct instinct about the one thing event-sourced
systems always get wrong late.

---

## Appendix — If you build one thing

Build Stage 1's spine, which the design already scopes correctly: `spec` + `graph` + `runtime` + an
in-process driver + a golden-file harness, with **no database, no queue, no UI.**

Then, before Stage 3, do the thing the document doesn't:

1. Define `JournalEntry` concretely, and include in it the `now` and the ID seed used for that
   transition.
2. Add `engineVersion` to the run header and pin it.
3. Write a deliberately breaking change to `advance`, then fold an old journal through it and watch
   the state diverge.
4. Write the migration that fixes it.

Step 3 takes an afternoon and converts the abstract risk in §11 into something you've seen. It is
much cheaper to learn there than in Stage 3's chaos test — and cheaper still than in production,
where it presents as a run that quietly changed its mind about its own history.
