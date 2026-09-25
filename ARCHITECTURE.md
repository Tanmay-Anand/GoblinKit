# GoblinKit — Architecture

> **Status:** Design document, v0.1
> **Audience:** engineers building GoblinKit, and engineers building *the next* product on top of the same core.
> **Companion:** [README.md](README.md) for the product overview and repo layout.

---

## 0. How to read this document

GoblinKit is two things at once, and keeping them distinct is the whole point:

1. **A product** — a web app where a user drags nodes onto a canvas, wires them together, configures them, and the platform runs the result.
2. **A kit** — a set of layered packages where the product-specific parts are thin and swappable, so the next workflow-shaped product (an AI agent builder, an ETL tool, an approval-routing system, a CI pipeline editor) reuses the core instead of reimplementing it.

Every decision below is judged against one question: **does this stay true when the node set, the UI, and the execution backend all change?**

Sections 1–3 give the research grounding and the principles. Sections 4–8 are the core — the workflow document, graph semantics, and the execution engine. Sections 9–17 cover the surrounding system. Section 18 records decisions with their alternatives. Section 19 is the build order.

---

## 1. Prior art: what we studied, what we take, what we reject

Research was done across the products and topics you listed. Findings that actually changed the design are recorded here; the rest is noise.

### 1.1 n8n

n8n executes workflows defined as JSON. The engine (`WorkflowExecute` in `packages/core`) initializes with context + mode + `runExecutionData`, identifies a start node, and populates a `nodeExecutionStack` — a **stack-based iteration** over the node graph. A processing loop traverses the stack, fires lifecycle hooks per node, handles branching, and returns an `IRun` when the stack empties. Data moves between nodes as **items**. Retries are per-node (`retryOnFail`, `maxTries`, `waitBetweenTries`). Scaling is *regular mode* (one process does API + UI + webhooks + execution) or *queue mode* (Bull/Redis, a `WorkflowRunner` coordinator that either runs locally or enqueues, and `JobProcessor` workers).

Two features are genuinely excellent and we take both:

- **Partial execution.** `runPartialWorkflow2` computes an affected subgraph via a `DirectedGraph` so only the changed portion re-runs. Combined with **pinned data** — a node returns fixed values instead of executing — this is the single biggest authoring-velocity feature in the category. Most clones skip it. We build it in from day one (§7.8).
- **The item model.** Nodes emit arrays of items, and downstream nodes run over them. It is more ergonomic than Make's bundles for the common case.

What we reject:

- **The execution stack as the engine's public shape.** A mutable stack walked by an imperative loop is hard to test, hard to resume mid-flight, and couples scheduling to the process that runs it. We replace it with a pure reducer (§7).
- **Node code and node UI in one artifact.** n8n's `INodeType` bundles `description` (which drives the editor UI) with `execute` (server code). Shipping them together means the editor's knowledge of a node is entangled with executable server code. We split manifest from executor (§12).
- **Late-added `typeVersion`.** Node versioning that arrives after the fact produces migration pain forever. We make `type@version` mandatory from the first node (§4.4).

### 1.2 Zapier and Make

Zapier's trigger→action linearity is the reason it is learnable, and the reason it hits a ceiling. Make uses **bundles**: data flows as bundles, an **Iterator** splits an array into one bundle per element, an **Aggregator** collects bundles back into one, and a **Router** splits a scenario into conditional branches.

What we take: Make's explicitness about **fan-out and fan-in as first-class, visible operations**. When iteration is implicit, users cannot see or reason about the cardinality of data at a given edge, and every non-trivial scenario becomes guesswork. GoblinKit makes cardinality explicit in the graph and visible in the editor (§6.3).

What we reject: forcing an explicit Iterator node for the common case. We take n8n's default (nodes map over items) but make the mapping mode a declared property of each node (`executionMode`), and surface it in the UI, so the behaviour is never hidden (§6.4).

### 1.3 Node-RED

Node-RED's contribution is the **wire as the unit of composition** and a node contract small enough that a hobbyist can write one in an afternoon. Its message model (`msg` mutated and passed along) is the wrong choice for a multi-tenant server — mutation-in-place makes provenance and replay impossible. We keep the small node contract, discard mutable messages in favour of immutable envelopes (§6).

### 1.4 React Flow / xyflow

React Flow renders every node as a real React component, and handles dragging, panning, zooming, edge routing, multi-select, snapping and viewport persistence. That DOM-based approach costs raw performance versus canvas/WebGL, and buys the entire React ecosystem inside each node.

The performance guidance is specific and we encode it as lint-enforced rules (§15.3):
- Components passed as props to `<ReactFlow>` must be `React.memo`'d or declared outside the parent; callbacks need `useCallback`; objects like `defaultEdgeOptions` need `useMemo`.
- **Never derive state by scanning the full `nodes` array.** Keep selection and derived state in the store, or every unrelated node update cascades a re-render.
- Toggle `hidden` rather than unmounting for progressive disclosure.
- Keep node CSS cheap — shadows, gradients and animations compound badly at scale.

The most important structural advice: **own the graph state in your own store and let React Flow render it.** React Flow is a view, not a model. Our document is the model, and it is serializable and framework-free (§4).

Layout: `dagre` is fast and simple with few options; `elkjs` is far more configurable and far more complex. We use dagre for the default auto-layout and keep the layout engine behind an interface so elkjs can be swapped per product.

### 1.5 Temporal

Temporal represents each execution as a durable event log (workflow started, activity scheduled, activity completed, timer fired). On restart, the worker **replays workflow code from the beginning**, skipping already-completed activities and reconstructing in-memory state — a crash at step 5 of 10 resumes at step 6. This requires the workflow definition to be **deterministic**: the same input must produce the same commands in the same sequence, or replay fails on a non-determinism mismatch. Non-deterministic work goes in activities (or side effects).

This is the correct model for workflows-as-code. It is the **wrong contract for workflows-as-user-data**: you cannot ask an end user dragging boxes on a canvas to maintain determinism, and a user editing a running workflow's graph is exactly the non-determinism mismatch Temporal forbids.

But the *decomposition* is right, and we take it wholesale:
- **The event history is the source of truth**, not a mutable state blob.
- **A pure, deterministic decision layer** separated from an impure execution layer.

GoblinKit applies this at the *step* boundary rather than the *code* boundary: our graph interpreter is the deterministic part (it is a pure reducer over the journal), and node executions are the activities. We get durability, resume, and time-travel debugging without imposing determinism on user-authored content. And because the decision layer is pure, a Temporal-backed driver is a legitimate future backend rather than a rewrite (§8.4).

### 1.6 Airflow

Airflow gives us vocabulary and two warnings. Vocabulary: DAG, task instance, trigger rules (`all_success`, `one_failed`, `none_failed_min_one_success`) — a well-explored design space for join semantics that we adapt into port join policies (§5.5). Warnings: (a) scheduler-as-database-poller has a latency floor and a well-known contention profile at scale; (b) defining pipelines in the same language and process as the platform blurs the boundary between user content and platform code. GoblinKit's workflows are data, never code.

### 1.7 Langflow and Dify

Dify is a full LLM-app platform (Python/Flask/Postgres backend, Next.js frontend) with an opinionated split between "chatflow" and "workflow" that constrains advanced use; RAG is first-class rather than bolted on. Langflow compiles flows down to LangChain and supports LangGraph-style multi-agent graphs with conditional edges, cycles, and state; custom Python nodes are natural rather than bolted on.

Lesson taken: **the canvas must not be specialized to one domain.** Dify's constraint comes from baking a use case into the graph semantics. GoblinKit's core knows about nodes, ports, envelopes and scopes — it does not know what an "LLM" or a "retriever" is. Those are node packs. This is precisely the reuse property you asked for.

Lesson taken: **cycles are not optional.** Agent loops, retry-until-condition, and paginated fetch all need iteration. We support them as *scoped* cycles rather than arbitrary ones (§5.6).

### 1.8 Queues and durability

BullMQ is the full-featured Redis queue (priorities, delayed jobs, rate limiting, repeatable jobs, flows/dependencies). pg-boss is Postgres-only, uses `SKIP LOCKED` for safe concurrency, and offers ACID guarantees, cron scheduling, retries with backoff, priorities, dead-letter queues, and transaction adapters. Guidance for greenfield 2026 projects turns on job complexity rather than infrastructure philosophy. Temporal is the most battle-tested durable orchestrator but is notably harder to self-host than Postgres-durability alternatives. Microsoft's `pg_durable` (open-sourced June 2026) runs durable, checkpointed workflows inside Postgres itself.

Our decision (ADR-007): **pg-boss first, BullMQ behind the same port when throughput demands it.** The deciding factor is not features — it is that pg-boss lets us **enqueue the job in the same transaction as the state write**. Dual-write between a Postgres state table and a Redis queue is the single most common source of lost or duplicated executions in systems of this shape. One transaction eliminates the entire class of bug. We give that up only when we have measured a reason to.

### 1.9 Sandboxing user code

Node's own documentation states plainly that `node:vm` is not a security mechanism; code running in it has access to the Node runtime and can spawn processes and touch the filesystem. The real options are **isolated-vm** (real V8 isolates, separate heaps, no shared prototype chain, with isolate setup/teardown overhead) and **QuickJS compiled to WebAssembly** (a JS interpreter inside a WASM sandbox, so host V8 bugs do not translate directly into escapes).

Decision (ADR-011): **QuickJS-WASM for user code nodes.** The WASM boundary is a stronger and simpler story than a native addon, it gives deterministic fuel/instruction limits (real CPU bounding, not just a wall clock), and it has no native build step to fight across platforms. isolated-vm stays available behind the same `CodeSandbox` port for tenants who need V8 speed on a dedicated runner pool.

### 1.10 Idempotency

The pattern is consistent across sources: use the provider's own event ID as the idempotency key (Stripe's event ID, GitHub's delivery GUID), hash the raw body only when no ID exists, scope keys by source and environment, set a TTL longer than the provider's retry window, and make the claim **atomic** — `INSERT ... ON CONFLICT DO NOTHING` or Redis `SET NX`. Critically: the receiver must durably decide whether the event was already handled *before any outward action begins*.

We implement exactly this at the ingress (§10.3) and additionally derive a per-step idempotency key that node executors can forward to upstream APIs (§11.6) — so idempotency is available at both the platform edge and the integration edge.

---

## 2. Design principles

These are the invariants. A change that violates one needs an ADR.

**P1 — The document is the contract.** A workflow is a serializable JSON document. It is the only thing shared between editor, engine, and storage. Nothing in it references a runtime type, a React component, or a database row.

**P2 — Decide purely, execute impurely.** All scheduling logic lives in a pure function of `(state, event)`. Anything that touches the network, clock, disk, or randomness happens in a driver, outside the decision layer. This gives us testing, replay, crash recovery, and backend portability from one mechanism.

**P3 — The journal is the truth.** Run state is a fold of an append-only event journal. Any state you cannot rebuild from the journal is a cache and must be rebuildable.

**P4 — Manifests are data, executors are code.** What a node *looks like and accepts* is declarative JSON. What it *does* is server-side code. The browser gets the first and never the second.

**P5 — I/O behind ports.** The core depends on interfaces, never on Postgres, Redis, S3, or HTTP. Every adapter is replaceable, and every one has an in-memory implementation used by the test suite.

**P6 — Everything is versioned and migrated.** Documents, node types, and credential schemas each carry a version and a forward migration. A workflow saved today must run in two years.

**P7 — Multi-tenant by construction.** Every table, every queue message, every log line carries a tenant ID. There is no "add tenancy later" path.

**P8 — The core is domain-agnostic.** The engine knows nodes, ports, envelopes, scopes. It never knows "HTTP", "Slack", or "LLM". Those live in node packs.

---

## 3. Layers and package graph

```
┌───────────────────────────────────────────────────────────────────────┐
│  Applications                                                          │
│  apps/web (editor + console)   apps/api (HTTP)   apps/worker (runner)  │
└───────────────────────────────────────────────────────────────────────┘
        │                    │                          │
┌───────▼──────────┐ ┌───────▼──────────┐ ┌─────────────▼──────────────┐
│  @goblin/editor  │ │ @goblin/server   │ │  @goblin/drivers-*         │
│  React Flow UI   │ │ API, ingress,    │ │  in-process | queue | ...  │
│  schema forms    │ │ auth, triggers   │ │                            │
└───────┬──────────┘ └───────┬──────────┘ └─────────────┬──────────────┘
        │                    │                          │
        │            ┌───────▼──────────────────────────▼──────────────┐
        │            │  @goblin/runtime                                │
        │            │  scheduler (pure reducer) · ports · policies    │
        │            └───────┬──────────────────────────┬──────────────┘
        │                    │                          │
┌───────▼────────────────────▼──────┐        ┌──────────▼──────────────┐
│  @goblin/spec                     │        │  @goblin/nodes-*        │
│  document types · zod · migrate   │◄───────┤  manifests + executors  │
└───────┬───────────────────────────┘        └─────────────────────────┘
        │
┌───────▼───────────────────────────┐
│  @goblin/graph                    │
│  topo sort · cycles · subgraphs   │
└───────────────────────────────────┘
```

| Package | Responsibility | May depend on |
|---|---|---|
| `@goblin/spec` | Document types, zod schemas, validation, document + node migrations | *(nothing)* |
| `@goblin/graph` | Pure graph algorithms: topological order, cycle detection, reachability, affected-subgraph, scope resolution | `spec` |
| `@goblin/runtime` | The scheduler reducer, run state, command/event types, retry & join policies, port interfaces | `spec`, `graph` |
| `@goblin/node-sdk` | `defineNode`, manifest types, executor context types, test harness | `spec` |
| `@goblin/nodes-core` | Control flow, HTTP, transform, code, wait, sub-workflow | `node-sdk` |
| `@goblin/nodes-*` | Integration packs (slack, gmail, postgres, openai…) | `node-sdk` |
| `@goblin/drivers-inprocess` | Executes commands in one process — used by tests, CLI, local dev | `runtime` |
| `@goblin/drivers-queue` | pg-boss/BullMQ driver, leases, heartbeats, recovery | `runtime`, `persistence` |
| `@goblin/persistence` | Postgres repositories, journal store, blob store, outbox | `spec`, `runtime` |
| `@goblin/expressions` | `{{ }}` parser + evaluator (no `eval`), resolver context | `spec` |
| `@goblin/sandbox` | `CodeSandbox` port + QuickJS-WASM and isolated-vm implementations | *(nothing)* |
| `@goblin/editor` | React Flow canvas, node chrome, schema-driven config forms, document store | `spec`, `graph` |
| `@goblin/testing` | In-memory adapters, golden-file harness, node contract tests | all |

**The reuse boundary is the line under `@goblin/runtime`.** `spec` + `graph` + `runtime` + `node-sdk` is the kit. Everything above is one product's opinion. A future product replaces `apps/*`, `nodes-*`, and the editor's chrome — and keeps the rest untouched.

A dependency-cruiser rule enforces the table above in CI. `@goblin/runtime` importing `pg` is a build failure, not a code review comment.

---

## 4. The workflow document (`@goblin/spec`)

### 4.1 Shape

```ts
export interface WorkflowDocument {
  /** Document schema version — drives migrations. Not the workflow's own version. */
  readonly schemaVersion: number;            // e.g. 1

  readonly id: WorkflowId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly description?: string;

  readonly nodes: readonly NodeInstance[];
  readonly edges: readonly Edge[];

  /** Typed, validated inputs the run is started with. */
  readonly inputs?: JsonSchema;
  /** Workflow-scoped variables, resolvable as {{ $vars.x }}. Never secrets. */
  readonly variables?: Record<string, JsonValue>;

  readonly settings: WorkflowSettings;
  readonly meta: DocumentMeta;               // author, timestamps, tags
}

export interface NodeInstance {
  readonly id: NodeId;                       // stable, opaque; never renamed
  readonly type: NodeTypeId;                 // "core.http.request"
  readonly typeVersion: number;              // 1, 2, 3 …
  readonly label?: string;                   // user-facing, freely editable
  readonly config: JsonObject;               // validated against the manifest schema
  readonly credentials?: Record<string, CredentialRef>;  // reference only, never a secret
  readonly policy?: Partial<NodePolicy>;     // retry / timeout / onError overrides
  readonly ui: { position: XY; width?: number; collapsed?: boolean; notes?: string };
  readonly disabled?: boolean;
  readonly pinnedData?: Envelope;            // authoring aid — see §7.8
}

export interface Edge {
  readonly id: EdgeId;
  readonly from: { node: NodeId; port: PortId };
  readonly to:   { node: NodeId; port: PortId };
  /** Optional edge-level gate; evaluated against the source envelope. */
  readonly condition?: Expression;
  readonly ui?: { label?: string; waypoints?: XY[] };
}
```

Three properties matter more than the field list:

- **`NodeId` is stable and opaque.** Labels are for humans and change freely; IDs never change. Every run record, log line, and journal entry is keyed by `NodeId`. Renaming a node must not orphan its history — this is a specific, painful failure mode in tools that key by label.
- **Credentials are references.** `CredentialRef` is `{ id, type }`. A secret value never enters the document, therefore never enters the editor, an export, a version diff, or a support ticket.
- **`ui` is quarantined.** All presentation lives under `ui`. A headless consumer (CLI, API-authored workflow, LLM-generated workflow) ignores it entirely, and moving a node on the canvas produces a diff that is trivially recognizable as non-semantic.

### 4.2 Validation

`@goblin/spec` exports zod schemas and a `validateDocument(doc, registry)` that returns structured diagnostics rather than throwing:

```ts
export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: DiagnosticCode;        // 'UNKNOWN_NODE_TYPE' | 'PORT_MISMATCH' | 'UNSCOPED_CYCLE' | …
  path: DocumentPath;          // ['nodes', 3, 'config', 'url']
  message: string;
  quickFix?: QuickFix;
}
```

The same function runs in the editor (inline squiggles), in the API (reject bad saves), and at run start (fail fast with a precise reason). One implementation, three call sites — a rule that repeatedly pays off, because divergence between client and server validation is how invalid documents reach production.

### 4.3 Document migrations

```ts
export const documentMigrations: DocumentMigration[] = [
  { to: 2, describe: 'edges carry explicit port ids', up: (d) => ({ ... }) },
];
export function migrateDocument(raw: unknown): WorkflowDocument;
```

Migrations are forward-only, pure, and unit-tested against a corpus of real fixtures. Loading a document always migrates first; nothing downstream ever sees an old shape.

### 4.4 Node type versions

`typeVersion` is separate from `schemaVersion` and mandatory from the first node. A node pack ships a manifest per version plus a migration:

```ts
defineNode({
  type: 'core.http.request',
  version: 2,
  migrateFrom: {
    1: (config) => ({ ...config, headers: kvArrayToObject(config.headers) }),
  },
  // …
});
```

Rules: a published version is immutable; a breaking change is a new version; the runtime executes the version recorded in the document. This is the difference between "we can never change that node" and normal maintenance. n8n's experience is the cautionary tale — retrofitting this is materially harder than starting with it.

---

## 5. Graph semantics

Loose graph semantics are where workflow engines accumulate their subtlest bugs. This section is a specification, not a sketch.

### 5.1 Ports

A node declares input and output ports in its manifest. Edges connect port to port — never node to node.

```ts
export interface PortSpec {
  id: PortId;                       // 'main' | 'true' | 'false' | 'error'
  label?: string;
  required?: boolean;               // input only
  join?: JoinPolicy;                // input only, see §5.5
  schema?: JsonSchema;              // advisory; drives editor hints + optional strict mode
  cardinality?: 'one' | 'many';     // may multiple edges attach?
}
```

Ports give us conditional branching, error branches, and multi-input merges without special-casing any of them in the engine. `If` is just a node with `true`/`false` outputs. This is why the engine stays domain-agnostic.

### 5.2 Edge states

During a run, each edge is in exactly one state:

| State | Meaning |
|---|---|
| `Pending` | Source has not resolved |
| `Delivered(envelope)` | Source emitted on this port |
| `Pruned` | Source ran but did not emit on this port, or source was skipped |

Pruning is the mechanism that makes conditional branches work. There is no separate "branch" concept in the engine.

### 5.3 Readiness

> A node is **Ready** when, for every input port, the port's join policy is satisfied, and no inbound edge is still `Pending`.

### 5.4 Skipping

> A node is **Skipped** when every inbound edge on every *required* input port is `Pruned`.
> A Skipped node prunes all of its outbound edges. Pruning therefore propagates transitively, and the untaken side of a branch collapses in a single pass with no reachability re-analysis.

### 5.5 Join policies

Adapted from Airflow's trigger rules, narrowed to what is comprehensible on a canvas:

| Policy | Node becomes Ready when |
|---|---|
| `all` *(default)* | every inbound edge is `Delivered` |
| `any` | at least one inbound edge is `Delivered`; remaining `Pending` edges are pruned |
| `race` | first `Delivered` wins; the run cancels sibling in-flight branches |
| `collect` | all inbound edges resolve (`Delivered` **or** `Pruned`); node sees which is which |

`collect` is what you want for "run this cleanup regardless of which branch ran" and is the policy most engines are missing, forcing users into awkward merge gymnastics.

### 5.6 Scopes, loops, and node run addressing

The topology is a DAG **of scopes**. Cycles are legal only through an edge whose target is a `ScopeStart` node — a "loop-back edge". Any other cycle is a validation error (`UNSCOPED_CYCLE`) with a quick-fix offering to insert a loop scope.

```
      ┌───────────────── loop back ─────────────────┐
      ▼                                             │
 [ScopeStart:loop1] ──▶ [transform] ──▶ [http] ──▶ [ScopeEnd:loop1] ──▶ [summary]
      │                                                  (done)
```

This buys three things arbitrary cycles cannot:

1. **Termination bounds.** Every scope carries `maxIterations` and `maxDuration`. Runaway loops are structurally impossible, not merely discouraged.
2. **Addressable node runs.** A node run is keyed by `(nodeId, scopePath)` where `scopePath` is `loop1[3]/inner[0]`. Every execution inside a loop is individually addressable in the journal, the UI, and the logs. Engines that key by `nodeId` alone lose per-iteration history entirely.
3. **Legible visuals.** A scope renders as a container, so users see the loop instead of inferring it from a back-edge.

`ScopeStart` variants cover the real cases: `forEach` (iterate items), `while` (condition), `retryUntil` (condition + backoff), `parallel` (fan-out with a concurrency cap).

### 5.7 Static validation

Run before save and before execution:

- unknown node type or version → `UNKNOWN_NODE_TYPE`
- edge references a missing node or port → `PORT_MISMATCH`
- cycle not through a `ScopeStart` → `UNSCOPED_CYCLE`
- required input port with no inbound edge → `MISSING_REQUIRED_INPUT`
- unreachable node (no path from any trigger) → warning `UNREACHABLE`
- config fails the manifest schema → `INVALID_CONFIG` (path-precise)
- expression references an unreachable node's output → `INVALID_REFERENCE`
- `cardinality: 'one'` port with multiple inbound edges → `PORT_OVERSUBSCRIBED`

---

## 6. What flows on an edge

### 6.1 Envelopes and items

```ts
export interface Envelope {
  readonly items: readonly Item[];
  readonly meta: EnvelopeMeta;      // emitting node, port, scopePath, timing
}

export interface Item {
  readonly data: JsonValue;
  readonly binary?: Record<string, BinaryRef>;
  readonly lineage?: Lineage;       // which upstream item(s) produced this
  readonly error?: ItemError;       // per-item failure, for partial success
}

export interface BinaryRef {
  readonly key: BlobKey;            // pointer into the blob store
  readonly mimeType: string;
  readonly size: number;
  readonly fileName?: string;
}
```

Three deliberate choices:

- **Immutable.** Nodes return new envelopes; they never mutate input. Provenance, replay, and concurrent branches all depend on this. (Node-RED's mutable `msg` is the counter-example.)
- **Binary by reference, always.** Base64 blobs inside the journal is a known n8n scaling wall — it inflates every persisted execution and every queue message. `BinaryRef` points at S3/MinIO/disk via the `BlobStore` port. Blobs are content-addressed and reference-counted against runs.
- **Per-item errors.** A 100-item batch where item 37 fails should not fail the other 99. `item.error` plus an `error` output port gives partial-success semantics, which real integrations need constantly.

### 6.2 Lineage

```ts
export type Lineage = { sourceNode: NodeId; sourcePort: PortId; itemIndex: number }[];
```

This is n8n's `pairedItem` idea, made explicit and mandatory. It powers "where did this value come from?" in the run inspector — the debugging feature users need most and get least, because it must be threaded through from the start.

### 6.3 Cardinality is visible

The editor annotates edges with observed cardinality after a run (`1 → 12 items`), and node manifests declare cardinality transforms (`1:1`, `1:N`, `N:1`, `N:M`). This is Make's clarity without Make's mandatory Iterator node.

### 6.4 Execution modes

Each node manifest declares how it consumes its input envelope:

| Mode | Behaviour |
|---|---|
| `batch` | executor receives the whole `Item[]` once (bulk inserts, aggregations) |
| `perItem` | runtime invokes the executor once per item, with `concurrency` and per-item error isolation |
| `single` | executor receives only `items[0]`; a warning fires if more arrive |

`perItem` is the default for integration nodes: the runtime owns the loop, so concurrency limits, per-item retries, rate limiting, and per-item error routing are implemented **once in the engine** rather than in every node. That is a large, permanent reduction in node-pack complexity.

---

## 7. The execution core

This is the heart of the kit, and the piece worth getting exactly right.

### 7.1 The central abstraction

```ts
/**
 * Pure. No I/O, no clock, no randomness, no async.
 * Same (state, event, ctx) always yields the same Transition.
 */
export function advance(
  state: RunState,
  event: RunEvent,
  ctx: SchedulerContext,
): Transition;

export interface SchedulerContext {
  readonly graph: CompiledGraph;      // pre-analyzed: adjacency, scopes, topo order
  readonly policies: ResolvedPolicies;
  readonly now: Timestamp;            // supplied by the driver, never read from Date
  readonly newId: (kind: IdKind) => string;  // seeded, deterministic per run
}

export interface Transition {
  readonly state: RunState;           // next state
  readonly commands: readonly Command[];   // side effects for the driver
  readonly journal: readonly JournalEntry[]; // facts to append atomically with state
}
```

The engine never performs a side effect. It *describes* them. A driver performs them and reports back as events.

```
        ┌──────────────────── Driver (impure) ────────────────────┐
        │  executes commands · owns clock, network, queue, DB     │
        └───────┬──────────────────────────────────▲──────────────┘
                │ commands                  events │
        ┌───────▼──────────────────────────────────┴──────────────┐
        │  advance(state, event, ctx) → { state, commands, journal }│
        │                    pure · deterministic                   │
        └───────────────────────────────────────────────────────────┘
```

### 7.2 Commands

```ts
export type Command =
  | { kind: 'InvokeNode';   invocation: NodeInvocation }
  | { kind: 'ScheduleTimer';timerId: TimerId; fireAt: Timestamp }
  | { kind: 'CancelTimer';  timerId: TimerId }
  | { kind: 'AwaitSignal';  signalId: SignalId; expiresAt?: Timestamp }
  | { kind: 'StartSubRun';  workflowId: WorkflowId; version: number; input: Envelope; correlationId: string }
  | { kind: 'CancelInvocation'; nodeRunId: NodeRunId; reason: CancelReason }
  | { kind: 'CompleteRun';  status: RunStatus; output?: Envelope; error?: RunError }
  | { kind: 'EmitMetric';   metric: MetricEvent };

export interface NodeInvocation {
  readonly nodeRunId: NodeRunId;      // deterministic: hash(runId, nodeId, scopePath, attempt)
  readonly nodeId: NodeId;
  readonly scopePath: ScopePath;
  readonly type: NodeTypeId;
  readonly typeVersion: number;
  readonly config: JsonObject;        // expressions still unresolved
  readonly input: PortInputs;
  readonly credentials: Record<string, CredentialRef>;
  readonly attempt: number;
  readonly deadline: Timestamp;
  readonly idempotencyKey: string;    // see §11.6
}
```

### 7.3 Events

```ts
export type RunEvent =
  | { kind: 'RunStarted';     trigger: TriggerEnvelope }
  | { kind: 'NodeSucceeded';  nodeRunId: NodeRunId; outputs: PortOutputs; metrics: NodeMetrics }
  | { kind: 'NodeFailed';     nodeRunId: NodeRunId; error: NodeError }
  | { kind: 'NodeProgress';   nodeRunId: NodeRunId; progress: Progress }
  | { kind: 'TimerFired';     timerId: TimerId }
  | { kind: 'SignalReceived'; signalId: SignalId; payload: JsonValue }
  | { kind: 'SubRunFinished'; correlationId: string; status: RunStatus; output?: Envelope }
  | { kind: 'CancelRequested';by: ActorRef; reason: string }
  | { kind: 'LeaseLost';      nodeRunId: NodeRunId };
```

### 7.4 What this buys

Making the scheduler pure is not aesthetic — each of these falls out for free:

| Capability | How it follows |
|---|---|
| **Crash recovery** | `state = journal.reduce(apply, initial)`. A worker dies mid-run; another folds the journal and continues. No bespoke recovery code. |
| **Time-travel debugging** | Fold the journal to entry *k* and inspect. "Show me the state right before node X failed" is a slice, not an investigation. |
| **Deterministic tests** | Golden-file tests: feed `(document, event[])` and assert the emitted command stream. Engine regressions are caught by diff. |
| **Backend portability** | In-process, queue-backed, and a hypothetical Temporal driver all consume the same commands. Switching backends does not touch scheduling logic. |
| **Debuggable production** | Export a run's journal from prod, replay locally, get identical behaviour — because the decision layer has no ambient inputs. |
| **Safe concurrency** | Commands are computed under a single-writer lease; the pure core has no shared mutable state to race on. |

This is Temporal's insight applied at the step boundary instead of the code boundary (§1.5).

### 7.5 Run state

```ts
export interface RunState {
  readonly runId: RunId;
  readonly status: 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
  readonly edges: ReadonlyMap<EdgeId, EdgeState>;
  readonly nodeRuns: ReadonlyMap<NodeRunId, NodeRunState>;
  readonly scopes: ReadonlyMap<ScopeInstanceId, ScopeState>;   // iteration counters, accumulators
  readonly pendingTimers: ReadonlyMap<TimerId, Timestamp>;
  readonly awaitedSignals: ReadonlyMap<SignalId, SignalWait>;
  readonly counters: RunCounters;                              // items processed, cost, credits
  readonly seq: number;                                        // journal position; optimistic lock
}
```

`seq` doubles as the optimistic concurrency token: a driver writing state at `seq = n` requires the stored value to still be `n`. Two workers racing on one run — the loser retries against fresh state. This is the guard that makes at-least-once delivery safe.

### 7.6 The scheduling loop

1. Driver delivers an event.
2. Driver loads `(state, seq)` under a run lease.
3. `advance(state, event, ctx)` → `{ state', commands, journal }`.
4. Driver writes `journal` + `state'` **in one transaction**, conditional on `seq`, and enqueues commands via the transactional outbox in that same transaction.
5. Transaction commits → outbox dispatcher performs the commands.
6. Node results return as new events. Repeat until `CompleteRun`.

Step 4 is where correctness lives. Journal, state, and outbound work commit atomically or not at all. This is why pg-boss is the default queue (§1.8) — with Redis, step 4 is a dual write and the failure modes come back.

### 7.7 Waiting without occupying a worker

`AwaitSignal` and `ScheduleTimer` mean a run that waits — for a human approval, a webhook callback, a `Wait 3 days` node, a rate-limit window — holds **no worker and no memory**. Its state is a row; a timer or an inbound signal revives it. Workflows waiting weeks cost the same as workflows waiting seconds. This is a hard requirement for approval flows and long-running agents, and retrofitting it is a rewrite.

### 7.8 Partial execution and pinned data

Taken from n8n (§1.1) because it dominates authoring experience:

- **Affected subgraph.** On "run from here", `@goblin/graph` computes the transitive downstream closure of edited nodes. Unaffected upstream nodes replay their cached output from the previous run's journal instead of re-executing. Editing the last node of a 12-node workflow re-runs one node, not twelve.
- **Pinned data.** `NodeInstance.pinnedData` short-circuits execution with a fixed envelope. Develop against a real API response captured once, without re-hitting the API on every iteration — and without a mock-server detour.
- **Cache validity.** A cached output is reusable only if `hash(config, resolvedExpressions, inputEnvelope, typeVersion)` is unchanged. The hash is computed by the pure core, so cache correctness is testable.

---

## 8. Drivers

A driver executes commands and returns events. All implement one port:

```ts
export interface RunDriver {
  start(input: StartRunInput): Promise<RunId>;
  signal(runId: RunId, signalId: SignalId, payload: JsonValue): Promise<void>;
  cancel(runId: RunId, reason: string): Promise<void>;
  observe(runId: RunId): AsyncIterable<RunEvent>;
}
```

### 8.1 In-process driver

Everything in one process, in-memory journal, deterministic fake clock. Used by unit tests, the `goblin run` CLI, and local development. Ships in the kit and is the reason the test suite needs no infrastructure. It is also the driver behind the first product: the local web app runs workflows with it, using a real clock and a journal appended to disk rather than held only in memory (§19, ADR-016).

### 8.2 Queue driver *(production default)*

- API enqueues `run.start`.
- A worker claims the run, takes a **lease** (row lock + expiry), and drives the loop from §7.6.
- Node invocations become queue jobs on class-specific queues: `node.fast`, `node.io`, `node.heavy`, `node.code`. Separating them stops one tenant's 30-second HTTP calls from starving everyone's fast transforms — a lesson every mature queue system learns late.
- Workers **heartbeat** the lease. A dead worker's lease expires; a recovery sweeper re-drives the run from the journal. Because state is a fold, recovery is not a special code path.
- Timers via pg-boss delayed jobs (or a `timers` table polled with `SKIP LOCKED`, which scales further and keeps timer semantics in our control).

### 8.3 Scaling profile

Mirrors n8n's regular/queue split (§1.1) but as a config switch rather than two code paths, because both drivers implement `RunDriver`:

| Deployment | Setup |
|---|---|
| Single binary | API + worker + in-process driver, one Postgres. Docker-compose, laptop, small self-host. |
| Standard | API replicas + worker replicas + Postgres + blob store + queue driver. |
| Large | Add per-class worker pools, per-tenant concurrency quotas, read replicas for run history, and a dedicated code-sandbox pool. |

### 8.4 A Temporal driver, if ever needed

Because the scheduler is pure, a Temporal driver is mechanical rather than architectural: a Temporal workflow whose body is the `advance` loop (deterministic by construction, satisfying Temporal's replay requirement — §1.5), with node invocations as activities. Worth doing only for genuinely long-lived, high-value workflows. **We do not build it now**, but the design does not foreclose it — and that optionality is the payoff of P2.

---

## 9. Persistence

Postgres is the source of truth. Row-level security by `tenant_id` on every table.

| Table | Purpose | Notes |
|---|---|---|
| `workflows` | identity, current published version | |
| `workflow_versions` | immutable document snapshots | runs pin a version; editing never changes a running workflow |
| `runs` | run header + folded state snapshot + `seq` | snapshot is a cache of the journal (P3) |
| `run_events` | **append-only journal** | `(run_id, seq)` primary key; the truth |
| `node_runs` | per-node-run index for queries and UI | derived; rebuildable |
| `trigger_events` | ingress dedup | unique `(tenant_id, source, idempotency_key)` |
| `credentials` | envelope-encrypted secrets | §14 |
| `schedules` | cron/interval bindings | |
| `webhooks` | path → workflow+node bindings | |
| `blobs` | content-addressed binary metadata | refcounted against runs |
| `outbox` | transactional command dispatch | drained by a dispatcher |

**Retention.** Journals grow fast. Policy from day one: hot journal in Postgres for N days, then compact (keep node run headers + errors, move envelopes to blob storage), then delete on tenant retention policy. Building this after launch means building it under load, which is the worst time.

**Snapshotting.** Long-running runs snapshot folded state every K journal entries so recovery is `snapshot + tail` rather than a full fold. Standard event-sourcing hygiene.

---

## 10. Triggers and ingress

### 10.1 One abstraction

```ts
export interface TriggerBinding {
  id: TriggerId;
  workflowId: WorkflowId;
  nodeId: NodeId;                 // the trigger node in the document
  kind: 'webhook' | 'schedule' | 'poll' | 'event' | 'manual';
  config: JsonObject;
  enabled: boolean;
}
```

Every kind produces the same `TriggerEvent` into one ingress. The engine has no idea whether a run began from a webhook, a cron tick, or a button. That uniformity is what lets a future product add a new trigger kind without touching the core.

### 10.2 Kinds

- **Webhook** — `POST /w/{tenant}/{path}`. Signature verification per provider, response mode `immediate` (ack now, run async — the correct default) or `lastNode` (respond with a node's output, bounded timeout).
- **Schedule** — cron/interval. A single scheduler process (leader-elected via a Postgres advisory lock) materializes due ticks into trigger events. Tick identity is `(triggerId, scheduledFor)`, which makes missed-tick catch-up and duplicate suppression exact rather than best-effort.
- **Poll** — periodic fetch with cursor state persisted per trigger, plus a dedup window on returned record IDs. The cursor lives in platform state, not in the node's config, so the node stays stateless.
- **Event** — internal bus / queue consumption for product-specific sources.
- **Manual** — editor "Execute workflow", carrying the actor for audit.

### 10.3 Idempotency at the edge

Following the pattern research converged on (§1.10):

```ts
function idempotencyKeyFor(req: IncomingTrigger): string {
  return req.providerEventId              // Stripe event id, GitHub delivery guid, …
      ?? req.headers['idempotency-key']
      ?? sha256(canonicalize(req.rawBody));
}
```

The claim is atomic and happens **before any side effect**:

```sql
INSERT INTO trigger_events (tenant_id, source, idempotency_key, received_at, payload_ref)
VALUES ($1, $2, $3, now(), $4)
ON CONFLICT (tenant_id, source, idempotency_key) DO NOTHING
RETURNING id;
```

No row returned → duplicate → return the original response, start nothing. TTL exceeds the provider's retry window (30 days covers every major provider). Keys are scoped by tenant, source, **and environment**, so a staging replay can never collide with production.

---

## 11. Reliability

### 11.1 Error classification

Every node error is classified, because the class determines the policy:

```ts
export type NodeErrorClass =
  | 'transient'        // network blip, 5xx, timeout        → retry
  | 'rate_limited'     // 429 with optional Retry-After     → retry, honour the hint
  | 'auth'             // 401/403                           → fail fast, flag credential
  | 'validation'       // 4xx from bad config/input         → fail fast, surface to user
  | 'permanent'        // logic error                       → fail fast
  | 'cancelled';
```

The SDK provides `classifyHttpError` so node authors get this right by default rather than by diligence.

### 11.2 Retry policy

```ts
export interface RetryPolicy {
  maxAttempts: number;              // default 3
  backoff: 'fixed' | 'exponential'; // default exponential
  initialDelayMs: number;           // default 1000
  maxDelayMs: number;               // default 60_000
  jitter: 'none' | 'full';          // default full
  retryOn: NodeErrorClass[];        // default ['transient','rate_limited']
  respectRetryAfter: boolean;       // default true
}
```

Resolution order: node override → workflow default → tenant default → platform default. Full jitter is the default because synchronized retry storms after a provider outage are the failure mode that turns one incident into two.

### 11.3 Timeouts and cancellation

Every invocation carries a deadline. Executors receive an `AbortSignal`; the SDK's HTTP client wires it automatically. Cancellation is cooperative first, lease-expiry second. A node that ignores its signal loses its lease and its result is discarded — never applied late, which would corrupt a resumed run.

### 11.4 Failure routing

Per node, `onError`:

- `stopRun` *(default)* — mark run failed
- `continue` — treat the error as output on the `error` port; downstream handles it
- `continueWithEmpty` — prune outputs, keep the run alive
- `route` — send to the `error` port explicitly

Plus an optional **workflow-level error handler**: a second workflow invoked with the failed run's context. This is n8n's error-workflow pattern and it is the difference between "we found out from a customer" and "we got paged".

### 11.5 Dead letter

Runs that exhaust retries or fail to schedule land in a DLQ with the full journal attached. Operators inspect, fix a credential or config, and **replay from the failed node** — the journal makes upstream results available without re-running them. This is directly enabled by §7.4.

### 11.6 Step-level idempotency keys

```
idempotencyKey = base64url(sha256(runId ‖ nodeId ‖ scopePath ‖ attemptGroup ‖ inputHash))
```

Stable across retries of the same logical step, different across genuinely different steps. Passed to executors, and integration nodes forward it as `Idempotency-Key` to providers that support it (Stripe, and increasingly others). The result: a retried "create charge" node does not double-charge — **the platform makes this correct rather than each node author remembering it**. This is the primitive that turns at-least-once execution into effectively-once business behaviour (§1.10).

### 11.7 Compensation

Sagas are not in v1, but the hook exists: a node manifest may declare `compensate`, and a scope may declare `compensateOnFailure`. When a scope fails, the engine emits `InvokeNode` compensation commands in reverse completion order. The command/event model already supports it; only the reducer branch is unwritten. Recorded here so v1 does not close the door.

---

## 12. The node SDK

This is the API third-party and future-you write against most. It deserves the most care.

### 12.1 Manifest and executor are separate artifacts

```ts
// manifest.ts — pure data. Serializable. Ships to the browser.
export const manifest = defineManifest({
  type: 'core.http.request',
  version: 2,
  title: 'HTTP Request',
  group: 'core',
  icon: 'globe',
  description: 'Make an HTTP request',
  executionMode: 'perItem',
  ports: {
    inputs:  [{ id: 'main', required: true, join: 'all' }],
    outputs: [{ id: 'main' }, { id: 'error' }],
  },
  credentials: [
    { type: 'httpAuth', required: false, when: { field: 'authMode', notEquals: 'none' } },
  ],
  config: {
    schema: z.object({
      method: z.enum(['GET','POST','PUT','PATCH','DELETE']).default('GET'),
      url: expression(z.string().url()),
      headers: z.record(expression(z.string())).default({}),
      body: expression(z.unknown()).optional(),
      timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
    }),
    ui: {
      order: ['method','url','headers','body','timeoutMs'],
      widgets: { body: 'code-editor', headers: 'key-value' },
      show: { body: { field: 'method', in: ['POST','PUT','PATCH'] } },
    },
  },
  defaults: { policy: { retry: { maxAttempts: 3 } } },
  migrateFrom: { 1: (c) => ({ ...c, headers: kvArrayToObject(c.headers) }) },
});
```

```ts
// executor.ts — server only. Never bundled for the browser.
export const executor = defineExecutor(manifest, async (ctx) => {
  const cfg = await ctx.resolveConfig();          // expressions evaluated here
  const auth = await ctx.credentials.get('httpAuth');

  const res = await ctx.http.request({            // SSRF-guarded, metered, traced
    method: cfg.method,
    url: cfg.url,
    headers: { ...cfg.headers, ...auth?.headers, 'Idempotency-Key': ctx.idempotencyKey },
    body: cfg.body,
    signal: ctx.signal,
    timeoutMs: cfg.timeoutMs,
  });

  if (!res.ok) throw ctx.error.fromHttp(res);     // auto-classified per §11.1
  return ctx.emit.main([{ data: res.json }]);
});
```

Why the split matters:

- The editor renders any node from its manifest alone. Manifests are **fetchable JSON**, so a node registry can be dynamic without shipping server code to the client (P4).
- Manifests are analyzable: docs, JSON-schema export, LLM-assisted workflow generation, static validation, and search all read one artifact.
- Adding a node to the editor cannot accidentally add a server dependency to the browser bundle.

The `when` / `show` conditional-visibility pattern comes straight from n8n's `displayOptions`, which is well-proven — the difference is that ours lives in declarative data with no code path attached.

### 12.2 Executor context

Everything a node can do arrives through `ctx`. Nodes do not `import` HTTP clients, loggers, or database drivers.

```ts
export interface NodeContext<C> {
  readonly items: readonly Item[];      // 'batch' mode
  readonly item: Item;                  // 'perItem' mode
  resolveConfig(): Promise<C>;          // expressions resolved against run scope

  readonly credentials: { get<T>(name: string): Promise<T | undefined> };
  readonly http: MeteredHttpClient;     // SSRF guard, allowlist, timeout, retry hooks, tracing
  readonly sandbox: CodeSandbox;        // §13.2
  readonly blobs: BlobStore;
  readonly logger: Logger;              // auto-redacted, run/node scoped
  readonly metrics: MetricsSink;
  readonly signal: AbortSignal;
  readonly idempotencyKey: string;      // §11.6
  readonly attempt: number;
  readonly run: { id: RunId; tenantId: TenantId; workflowId: WorkflowId; mode: RunMode };
  readonly state: ScopedKV;             // small, per-(workflow,node) durable KV — poll cursors
  readonly emit: EmitApi;               // emit.main(items) / emit.port('error', items)
  readonly error: ErrorFactory;         // classified error construction
}
```

This inversion is what makes nodes testable, meterable, and safe. A node cannot bypass the rate limiter, escape the egress allowlist, leak a credential into a log, or make an untraced call — because it has no unmediated access to any of it. Governance lives in the platform, not in the discipline of node authors.

### 12.3 Node testing

```ts
describe('core.http.request', () => {
  it('routes 500 to the error port after retries', async () => {
    const t = createNodeHarness(manifest, executor);
    t.http.mock('POST https://api.test/x').replyTimes(3, 500);
    const out = await t.run({ config: { method: 'POST', url: 'https://api.test/x' } });
    expect(out.port).toBe('error');
    expect(out.attempts).toBe(3);
  });
});
```

`@goblin/testing` also runs a **contract suite** against every registered node: manifest validates, config schema round-trips, migrations are total, ports are declared, secrets never appear in emitted items or logs, `AbortSignal` is respected. Every node pack gets baseline quality without per-node effort.

### 12.4 Registry and distribution

```ts
export interface NodeRegistry {
  manifests(): Promise<NodeManifest[]>;                 // browser-safe
  manifest(type: NodeTypeId, version: number): Promise<NodeManifest>;
  executor(type: NodeTypeId, version: number): Promise<NodeExecutor>; // server only
}
```

v1: statically bundled packs. v2: signed, versioned packs loaded from a registry, executed on isolated worker pools. The interface is identical, so v2 is a deployment change rather than a redesign.

---

## 13. Expressions and user code

Two distinct mechanisms, deliberately not merged.

### 13.1 Inline expressions

`{{ $json.user.email }}` inside config fields. Requirements: safe by construction, cheap enough to evaluate per item, statically analyzable for dependency extraction and validation.

**Decision:** a small, purpose-built parser + AST evaluator in `@goblin/expressions`. No `eval`, no `new Function`, no JS semantics. Property access, indexing, comparisons, arithmetic, ternaries, and a curated function library (string/date/array/number/crypto-hash). Every function is documented, pure, and individually deprecable.

Resolution scope:

| Reference | Meaning |
|---|---|
| `$json` | current item's data |
| `$binary` | current item's binary refs |
| `$item.index`, `$item.count` | position within the batch |
| `$node["Fetch Users"].output` | another node's output (by label; compiled to `NodeId`) |
| `$vars.region` | workflow variables |
| `$run.id`, `$run.startedAt` | run metadata |
| `$scope.index` | loop iteration index |
| `$env.PUBLIC_*` | allowlisted env only |

Because the evaluator owns the AST, `extractReferences(expr)` gives us dependency edges for free — powering validation, "used by" navigation, and correct partial-execution invalidation. Handing this to a general JS engine would forfeit all of that.

Rejected: JSONata (powerful, but its learning curve becomes the product's learning curve), JMESPath (no interpolation, awkward for mixed strings), Liquid (templating semantics, weak on data), raw JS (unanalyzable and unsafe — see §13.2).

### 13.2 The Code node

Some users need real code. The research is unambiguous that `node:vm` is not a sandbox (§1.9).

**Decision:** `CodeSandbox` port with **QuickJS-WASM as default**:

```ts
export interface CodeSandbox {
  run(opts: {
    code: string;
    input: JsonValue;
    timeoutMs: number;
    memoryLimitMb: number;
    fuel?: number;                 // instruction budget — bounds CPU, not just wall clock
    allowNetwork?: false;          // v1: never
  }): Promise<SandboxResult>;
}
```

Rationale: a WASM boundary means host V8 vulnerabilities do not translate directly into escapes; fuel limits bound CPU deterministically (a wall-clock timeout does not stop a busy loop from burning a core); and there is no native addon to build across platforms. `isolated-vm` remains available behind the same port for tenants needing V8 speed, restricted to a dedicated worker pool with a lower trust boundary.

No network from inside the sandbox in v1. If a Code node needs to call something, it emits items and an HTTP node calls it — which keeps the call metered, traced, and governed (§12.2).

---

## 14. Credentials and security

### 14.1 Storage

Envelope encryption, per the pattern the research converged on (§1.10, §1.8): a fresh random **DEK per credential record**, secret encrypted with AES-256-GCM (random IV per value), DEK encrypted with a KMS master key, ciphertext + wrapped DEK stored together. Key rotation re-wraps DEKs without touching ciphertext. Local development uses a file-based KMS shim implementing the same `KeyProvider` port.

### 14.2 Handling

- Secrets **never** enter a workflow document, a journal entry, a log line, or an API response. Documents carry `CredentialRef` only (§4.1).
- Decryption happens in the worker, at invocation time, into a short-lived object that the executor reads via `ctx.credentials.get()`.
- Log redaction is structural: the logger holds the set of secret values for the current invocation and scrubs them from any output, including error messages and stack traces. Not a regex over known key names — an exact-value scrub, which is the version that actually holds.
- Per-tenant credentials, never one global OAuth app credential shared across tenants.

### 14.3 OAuth

A dedicated `OAuthManager`: PKCE flows, refresh with **single-flight locking per credential** (concurrent nodes must not race a refresh and invalidate each other's token), and clear handling of non-retryable failures — `invalid_grant` marks the credential `needs_reauth`, fails dependent runs with a `auth` class error, and notifies the owner. Automatic reactivation on successful re-auth. Token refresh races are the number one source of mysterious integration failures in this category, and single-flight is the fix.

### 14.4 Egress

The `MeteredHttpClient` enforces: DNS-resolution-time SSRF checks (block RFC1918, link-local, metadata endpoints — re-resolving after redirects to defeat DNS rebinding), an optional per-tenant domain allowlist, redirect caps, response size caps, and per-tenant rate limits. A user-authored HTTP node pointed at `169.254.169.254` is a real attack on a multi-tenant automation platform, and it must be blocked by the platform rather than by node authors.

### 14.5 Tenancy

`tenant_id` on every row with Postgres RLS; tenant scope carried in the queue message, the run state, and every log line; per-tenant quotas on concurrent runs, executions/month, node invocations, code-sandbox CPU, and blob storage. Quota checks happen at ingress (reject early) and at scheduling (fail cleanly), never mid-node.

---

## 15. The editor

### 15.1 Structure

```
apps/web
└── @goblin/editor
    ├── document/     WorkflowDocument store (zustand) + command/undo stack
    ├── canvas/       React Flow wrapper, node chrome, edges, scope containers
    ├── inspector/    schema-driven config forms from manifests
    ├── runs/         run inspector, per-node I/O, lineage viewer, journal timeline
    └── registry/     manifest fetching + search + palette
```

### 15.2 The document store owns truth

React Flow renders a **projection** of the document; it does not hold it. Per §1.4, own the graph state and let React Flow render it.

```ts
interface EditorStore {
  document: WorkflowDocument;
  selection: { nodes: NodeId[]; edges: EdgeId[] };   // NOT derived by scanning nodes
  diagnostics: Diagnostic[];
  lastRun?: RunProjection;

  apply(cmd: DocumentCommand): void;   // every mutation is a command
  undo(): void;
  redo(): void;
}
```

Every mutation is a `DocumentCommand` (`AddNode`, `MoveNodes`, `ConnectPorts`, `UpdateConfig`, …) with an inverse. Undo/redo operates on the document, not on React Flow's internal state — which is what makes undo coherent across canvas edits *and* inspector edits, the thing users notice immediately when it is wrong. Commands are also the natural unit for a future Yjs/CRDT collaboration layer, and for an AI "build me a workflow" feature that emits commands instead of rewriting JSON.

### 15.3 Performance rules (lint-enforced)

Direct from React Flow's guidance (§1.4):

1. `nodeTypes` / `edgeTypes` declared **outside** the component or `useMemo`'d. Custom nodes are `React.memo` with an explicit comparator.
2. **Never** derive state by scanning the full `nodes` array. Selection and derived data live in the store; components subscribe via narrow selectors.
3. Progressive disclosure toggles `hidden`, it does not unmount.
4. Node CSS stays cheap — no gradients, animations or large shadows on the node body.
5. Run-status updates stream into a **separate** store slice keyed by `NodeId`, so a live run repaints status badges without touching the document or re-rendering the graph.

Rule 5 matters specifically for this product: live execution highlighting is the feature most likely to make a large canvas stutter, because it is a high-frequency update against the same state the graph renders from.

### 15.4 Config forms

Rendered from `manifest.config.schema` + `manifest.config.ui`. Zero bespoke form code per node — the strongest argument for the manifest/executor split. Fields supporting expressions get an expression editor with autocomplete over the resolution scope (§13.1), populated from real upstream data when a previous run exists. Being able to see actual values while writing an expression is the difference between the feature being usable and being a guessing game.

### 15.5 Run inspector

Per node run: input envelope, output envelope, config **as resolved**, timing, attempts, errors, and item lineage (§6.2). A journal timeline scrubber replays run state to any point (§7.4). "Copy as failing test case" exports `(document, journal)` as a golden-file fixture for `@goblin/testing` — turning a support ticket into a regression test in one click.

### 15.6 Auto layout

`dagre` by default (fast, few knobs), behind a `LayoutEngine` interface so `elkjs` can be swapped in for products needing richer routing. Layout runs on explicit user action and on import, never continuously — layout that fights the user's manual positioning is worse than no layout.

---

## 16. Observability

- **Tracing.** OpenTelemetry throughout. One trace per run; a span per node run; HTTP calls inside nodes are child spans. `trace_id` is written into the journal, so a run in the UI links to its trace and vice versa.
- **Metrics.** Run duration/status/tenant, node duration/status/type, queue depth and age per class, lease expiries, retry counts by error class, sandbox fuel consumption, expression evaluation time. Queue **age** (not depth) is the metric that predicts user-visible slowness.
- **Logs.** Structured, always carrying `tenant_id`, `run_id`, `node_run_id`, `scope_path`; redacted per §14.2.
- **Audit.** Separate append-only log for workflow published/unpublished, credential created/rotated/deleted, manual run triggered, run cancelled, quota changed — with actor. This is the log compliance reviews ask for, and it must not live in application logs.

---

## 17. Testing strategy

| Layer | Approach |
|---|---|
| `spec` | Property tests on migrations (idempotent, total); fixture corpus of real documents |
| `graph` | Property tests: topo order respects edges; cycle detection is exact; affected-subgraph ⊇ edited nodes |
| `runtime` | **Golden-file tests** — `(document, event[]) → command[]`. The core regression net (§7.4) |
| nodes | Harness tests + the shared contract suite (§12.3) |
| drivers | In-memory driver for logic; testcontainers Postgres for the queue driver; **chaos tests** that kill workers mid-run and assert exactly-once outcomes |
| editor | Component tests; a render-count budget test that fails if editing one node re-renders others |
| e2e | Playwright (`e2e/`): build a workflow from an empty canvas, run it, inspect results, break it, reopen a past run. Real server, real browser, own workspace; state arranged over the API, locators by role and accessible name. Replay-from-failure joins when Stage 5 builds it |

The golden-file suite for `runtime` is the highest-value test asset in the repo. Because `advance` is pure, a scheduling regression shows up as a readable diff in a command stream — which is the difference between catching engine bugs in CI and catching them in production.

---

## 18. Decision records

Compact ADRs: decision, alternatives, why.

**ADR-001 — Workflows are data, not code.**
*Alternatives:* workflows-as-code (Temporal, Airflow). *Why:* the product's premise is non-developers authoring visually. Data is versionable, diffable, migratable, LLM-generatable, and safe to accept from untrusted tenants. Code is none of those.

**ADR-002 — Pure scheduler + impure drivers.**
*Alternatives:* n8n's imperative execution stack; direct-to-queue orchestration. *Why:* one mechanism yields crash recovery, replay debugging, deterministic tests, and backend portability (§7.4). The single highest-leverage decision here, and the main reason the core is reusable.

**ADR-003 — Journal as source of truth.**
*Alternatives:* mutable run-state row. *Why:* resume-after-crash and time-travel debugging both require the history. Snapshots keep it fast (§9).

**ADR-004 — Step-level durability, not code replay.**
*Alternatives:* Temporal-style deterministic replay. *Why:* determinism cannot be imposed on user-authored graphs, and users edit workflows that have runs in flight (§1.5). Step checkpointing gives durability without that constraint.

**ADR-005 — Scoped cycles, not arbitrary ones.**
*Alternatives:* pure DAG (Airflow) or free cycles (LangGraph). *Why:* pure DAGs cannot express agent loops or pagination; free cycles have no termination bound and no per-iteration addressing. Scopes give both, plus a legible visual (§5.6).

**ADR-006 — Postgres as source of truth.**
*Alternatives:* Mongo, event store, Redis-primary. *Why:* transactional journal + state + outbox in one commit removes the dual-write failure class (§7.6). Also the boring, operable choice.

**ADR-007 — pg-boss first, BullMQ behind a port.**
*Alternatives:* BullMQ/Redis from the start. *Why:* transactional enqueue (§1.8). BullMQ's flows and rate limiting are real advantages, but not worth reintroducing dual writes before we have throughput data. The port makes switching cheap.

**ADR-008 — Manifest / executor split.**
*Alternatives:* n8n's combined `INodeType`. *Why:* browser-safe node metadata, schema-driven forms with no per-node UI code, analyzable node catalog, no accidental server code in the client bundle (§12.1).

**ADR-009 — Mandatory `typeVersion` from node #1.**
*Alternatives:* add versioning when first needed. *Why:* retrofitting node versioning is one of the hardest migrations in this category (§4.4). The cost now is trivial.

**ADR-010 — Custom expression evaluator, not JSONata/JS.**
*Alternatives:* JSONata, JMESPath, Liquid, sandboxed JS. *Why:* owning the AST gives static reference extraction, which powers validation, dependency analysis, and partial-execution invalidation (§13.1). Third-party languages forfeit that and add a learning curve.

**ADR-011 — QuickJS-WASM for user code.**
*Alternatives:* `node:vm` (not a sandbox), `isolated-vm`. *Why:* WASM isolation boundary, deterministic fuel limits, no native build (§1.9, §13.2). `isolated-vm` stays available behind the same port.

**ADR-012 — Immutable envelopes with lineage.**
*Alternatives:* Node-RED's mutable `msg`. *Why:* provenance, replay, and parallel branches all require immutability; lineage is the top debugging feature and must be threaded from the start (§6.2).

**ADR-013 — Binary by reference, never inline.**
*Alternatives:* base64 in the payload. *Why:* inline binary inflates journals and queue messages and is a known scaling wall (§6.1).

**ADR-014 — Ports and join policies as the only branching primitive.**
*Alternatives:* special-case `If`/`Switch`/`Merge` in the engine. *Why:* keeps the engine domain-agnostic (P8); new control-flow shapes become node packs, not engine changes (§5).

**ADR-015 — React Flow with an external document store.**
*Alternatives:* React Flow as state owner; custom canvas/WebGL. *Why:* the document must be framework-free and serializable (P1); React Flow's own guidance is to own the state externally (§1.4). Canvas/WebGL wins on huge graphs but forfeits React inside nodes, which the config UX depends on.

**ADR-016 — The canvas before production durability; local single-user first.**
*Alternatives:* the original order (durability, then the editor, then the platform). *Why:* the product is "connect boxes, press Run", and none of it can be judged until that loop exists. One user on one machine needs no queue, no leases and no accounts, so Postgres and the queue driver would be solving problems the first product does not have. *What keeps this from becoming a rewrite:* local storage sits behind the same `WorkflowStore` / `RunStore` ports that Postgres later implements, with one shared contract test suite both must pass (P5). The local API is the real `apps/api` running without auth, not a throwaway server. And local mode uses a single fixed tenant id (`local`) that flows through every call, so P7's "no add-tenancy-later path" still holds. *Cost accepted:* until Stage 7, automatic runs happen only while the app is open, and a crash is recovered by folding journal files rather than by a sweeper.

---

## 19. Build order

Sequenced so that each stage is independently demonstrable, and so the reusable core is proven before product surface is built on it.

**The product loop comes first.** You start the app, pick boxes from a palette, connect them on a canvas, press **Run**, and watch the automation execute box by box. Every stage after Stage 2 either makes that loop possible or adds boxes to it. The first product is a **local web app for one user**: `pnpm dev`, open `localhost` in a browser, no login, workflows saved as files on your machine. Production durability, accounts and scale come after the loop works, in Stages 7–9. See ADR-016 for why this order replaced the original one.

Stages 1–2 are **done**. Stages 3–6 are the single-user product. Stages 7–9 are for when it is more than one person on one machine.

**Stage 1 — The kit's spine.** *Done.* `@goblin/spec` (types, zod, validation, migrations), `@goblin/graph` (topo, cycles, scopes, affected-subgraph), `@goblin/runtime` (`advance`, state, commands, events, join policies, retry), `@goblin/drivers-inprocess`. (`@goblin/testing` with the golden-file harness moved to Stage 3's entry gate; a determinism test covers the property it rests on until then.) Deliverable: `goblin run workflow.json` executes a real graph with branching, loops, retries, and skips — with no database, no queue, and no UI. *If this stage is right, everything after it is comparatively mechanical.*

**Stage 2 — The node SDK and the first boxes.** *Done, except the reusable contract suite, which moves to Stage 3.* `defineManifest` / `defineExecutor`, `ctx`, the harness, plus the first ten boxes in `nodes-core`: Manual trigger, HTTP Request, If, Switch, Merge, Set, ForEach, While, Wait, Log. The remaining boxes originally listed here are spread across Stages 4–6, each placed where the capability it needs arrives.

**Stage 3 — The canvas: the first usable app.** *Done.* The whole product loop, with the ten existing boxes. One piece shipped smaller than planned: a box inside a loop shows its pass count and the last pass's input and output, not a list of every pass. The journal holds all of them, so the list is a view to add, not data to capture.

- *Entry gate:* `@goblin/testing` with the golden-file harness and the node contract suite, finished before any UI leans on the engine (§17).
- `apps/web` + `@goblin/editor` (§15): document store with command/undo, React Flow canvas, a palette built from manifests, drag a box on, drag from an output port to an input port to connect, a schema-driven settings panel, validation diagnostics shown on the offending box and edge, auto-layout on demand.
- `apps/api` in **local mode**: serves the editor, and keeps a workspace folder on disk (`workspace/workflows/*.json`, `workspace/runs/*.journal.json`) behind `WorkflowStore` / `RunStore` ports. It runs workflows with the in-process driver (§8.1). Executors stay on this server and never reach the browser (ADR-008).
- **Run:** the Run button posts the document. The API streams journal entries back over Server-Sent Events. Each box shows running / succeeded / skipped / failed live, fed from the separate run-status slice (§15.3 rule 5). Click a box to see its input, output and error. Loop passes are listed per iteration.
- Save, open, rename and delete workflows, with a list of past runs per workflow.
- *Deliverable:* build `examples/order-triage.json` from an empty canvas, press Run, watch it light up, then reopen it tomorrow and find it and its runs still there. `pnpm dev` starts everything.

**Stage 4 — Boxes that start by themselves.** Schedule and Webhook triggers, plus an **Active** switch per workflow. The local API gains a scheduler and a `localhost` webhook URL per workflow. Runs must now survive closing the app, so this stage brings the part of durability a single machine needs. The journal is appended to disk entry by entry, and on startup the API folds unfinished journals and resumes them (§7.4). A Wait of three days outlives a restart. Automatic runs happen only while the app is running. That limit is stated in the UI, not hidden.

**Stage 5 — Power boxes and a better run view.** Code (QuickJS-WASM with fuel limits, §13.2, the real sandbox it has waited for), Sub-workflow, and an **AI step**: a box that calls a language model to summarize, classify, extract or generate, with the provider behind a port. The expression editor gains autocomplete from real upstream data (§15.4). Pinned data, re-run from a failed box, journal scrubbing, and "copy as failing test case" arrive here (§15.5).

**Stage 6 — App integrations.** Local credentials: encrypted at rest on disk, resolved only on the server, never sent to the browser. OAuth sign-in for the providers that require it. The first integration packs, each its own `nodes-*` package: **Slack**, **Email** (SMTP send, IMAP trigger), **Google Sheets**. After these, a new integration is a new pack, not an engine change.

**Stage 7 — Production durability.** `@goblin/persistence` on Postgres (journal, snapshots, outbox), implementing the same `WorkflowStore` / `RunStore` ports the local files did. Then `@goblin/drivers-queue` (leases, heartbeats, recovery sweeper, per-class queues), retention and compaction. Chaos test: kill workers mid-run, assert exactly-once outcomes.

**Stage 8 — The platform.** Accounts and auth, tenancy + RLS, credentials moved to envelope encryption + KMS, a shared OAuth manager, hosted webhook ingress with idempotency, a scheduler with leader election, quotas, error workflows.

**Stage 9 — Scale and open the platform.** Per-class worker pools, a dedicated sandbox pool, a node pack registry with signing, run-history retention tiers.

The reusable kit is still `spec` + `graph` + `runtime` + `node-sdk` + the drivers; `@goblin/editor` is reusable chrome on top. A second product built on GoblinKit keeps both and replaces the node packs and the app shell — which is the outcome you asked the architecture to deliver.

---

## Sources

- [How n8n Works Internally — Architecture & Execution Engine](https://www.c-sharpcorner.com/article/how-n8n-works-internally-architecture-execution-engine-explained/)
- [n8n Workflow Execution Engine (DeepWiki)](https://deepwiki.com/n8n-io/n8n/2-workflow-execution-engine)
- [n8n Runtime Architecture and Process Models (DeepWiki)](https://deepwiki.com/n8n-io/n8n/1.2-architecture-overview)
- [Inside n8n's Workflow Engine — Mahmoud Zalt](https://zalt.me/blog/2025/09/inside-n8n-workflow-engine)
- [Tutorial: Build a declarative-style node — n8n Docs](https://docs.n8n.io/integrations/creating-nodes/build/declarative-style-node/)
- [Tutorial: Build a programmatic-style node — n8n Docs](https://docs.n8n.io/integrations/creating-nodes/build/programmatic-style-node/)
- [React Flow — Performance](https://reactflow.dev/learn/advanced-use/performance)
- [React Flow — Layouting overview](https://reactflow.dev/learn/layouting/layouting)
- [React Flow — Workflow Editor template](https://reactflow.dev/ui/templates/workflow-editor)
- [React Flow Guide: Advanced Node-Based UIs — Velt](https://velt.dev/blog/react-flow-guide-advanced-node-based-ui)
- [Improving React Flow performance with many nodes (xyflow discussion #4975)](https://github.com/xyflow/xyflow/discussions/4975)
- [Temporal: Beyond State Machines for Reliable Distributed Applications](https://temporal.io/blog/temporal-replaces-state-machines-for-distributed-applications)
- [Temporal — Event History walkthrough (TypeScript SDK)](https://docs.temporal.io/encyclopedia/event-history/event-history-typescript)
- [Temporal — Develop code that durably executes](https://learn.temporal.io/tutorials/go/background-check/durable-execution/)
- [Temporal vs Restate vs Windmill 2026 — PkgPulse](https://www.pkgpulse.com/guides/temporal-vs-restate-vs-windmill-durable-workflow-2026)
- [BullMQ vs Bee-Queue vs pg-boss 2026 — PkgPulse](https://www.pkgpulse.com/guides/bullmq-vs-bee-queue-vs-pg-boss-job-queues-nodejs-2026)
- [BullMQ Alternatives for Webhook Retries — Hookdeck](https://hookdeck.com/webhooks/platforms/bullmq-alternatives-for-webhook-retries)
- [Durable Queue Workers With Just Postgres](https://mfyz.com/durable-queue-workers-with-just-postgres/)
- [Why Checkpoints Aren't Durable Execution — Diagrid](https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows)
- [AI Agent Workflow Checkpointing and Resumability — Zylos Research](https://zylos.ai/research/2026-03-04-ai-agent-workflow-checkpointing-resumability/)
- [The security concerns of a JavaScript sandbox with the Node.js VM module — Snyk](https://snyk.io/blog/security-concerns-javascript-sandbox-node-js-vm-module/)
- [node:vm Is Not a Sandbox — DEV](https://dev.to/dendrite_soup/nodevm-is-not-a-sandbox-stop-using-it-like-one-2f74)
- [sebastianwessel/quickjs — JS/TS execution in a WASM QuickJS sandbox](https://github.com/sebastianwessel/quickjs)
- [Sandboxing JavaScript Code — Andrew Healey](https://healeycodes.com/sandboxing-javascript-code)
- [Webhook Idempotency and Deduplication — Hooklistener](https://www.hooklistener.com/learn/webhook-idempotency-and-deduplication)
- [Idempotency and Deduplication in Workflow Automation — LogicLot](https://logiclot.io/docs/automation-idempotency-deduplication)
- [Idempotency Keys for Webhooks: A Practical Guide — Hookbase](https://www.hookbase.app/blog/idempotency-keys-for-webhooks)
- [Webhook Best Practices: Idempotency and Event Ordering — BoldSign](https://boldsign.com/blogs/webhook-best-practices-retries-idempotency/)
- [How to Architect a Scalable OAuth Token Management System — Truto](https://truto.one/blog/how-to-architect-a-scalable-oauth-token-management-system-for-saas-integrations/)
- [Simplifying Multi-Tenant Encryption with AWS KMS — CloudThat](https://www.cloudthat.com/resources/blog/simplifying-multi-tenant-encryption-with-a-cost-conscious-aws-kms-key-strategy)
- [Locking Down Your Workflows: OAuth2 & Credentials in n8n](https://medium.com/@duckweave/locking-down-your-workflows-oauth2-credentials-in-n8n-37fba8759da4)
- [Guide to Iterators, Aggregators, and Data Bundles in Make.com](https://lets-viz.com/blogs/guide-to-iterators-aggregators-and-data-bundles-in-make-com)
- [How to Use Iterators & Aggregators in Make.com — The AI Automators](https://www.theaiautomators.com/use-iterators-and-aggregators-in-makecom/)
- [n8n vs Make — n8n](https://n8n.io/vs/make/)
- [Dify vs Langflow vs Flowise: Which Ships to Production? — elest.io](https://blog.elest.io/dify-vs-langflow-vs-flowise-which-open-source-llm-app-builder-actually-ships-to-production/)
- [Open Source AI Agent Platform Comparison (2026) — Jimmy Song](https://jimmysong.io/blog/open-source-ai-agent-workflow-comparison/)
- [LangFlow: A Visual Guide to Building LLM Apps — Cohorte](https://cohorte.co/blog/langflow-a-visual-guide-to-building-llm-apps-with-langchain)
