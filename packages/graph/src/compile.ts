import type {
  Diagnostic,
  Edge,
  EdgeId,
  ManifestRegistry,
  NodeId,
  NodeInstance,
  NodeManifest,
  WorkflowDocument,
} from '@goblin/spec';

/**
 * Compiling a document is the one place graph shape is analysed.
 *
 * The engine receives a CompiledGraph and never walks the document again: at
 * run time "which edges leave this port" and "which scope is this node in"
 * must be lookups, not searches, because they happen on every event of every
 * run. Doing the analysis once also means the rules about cycles and scopes
 * have exactly one implementation to be right.
 */

export interface CompiledNode {
  readonly id: NodeId;
  readonly instance: NodeInstance;
  readonly manifest: NodeManifest;
  /** Scope this node executes inside, innermost last. Empty at the top level. */
  readonly scopeChain: readonly NodeId[];
}

export interface CompiledGraph {
  readonly document: WorkflowDocument;
  readonly nodes: ReadonlyMap<NodeId, CompiledNode>;
  readonly edges: ReadonlyMap<EdgeId, Edge>;
  /** node → edges leaving it. */
  readonly outgoing: ReadonlyMap<NodeId, readonly Edge[]>;
  /** node → edges arriving at it. */
  readonly incoming: ReadonlyMap<NodeId, readonly Edge[]>;
  readonly triggers: readonly NodeId[];
  /** Loop-back edges: the only legal cycles, and only into a scope start. */
  readonly loopBackEdges: ReadonlySet<EdgeId>;
  /** scope start node → its matching end node. */
  readonly scopeEnds: ReadonlyMap<NodeId, NodeId>;
  /** Topological order, ignoring loop-back edges. */
  readonly topoOrder: readonly NodeId[];
  readonly diagnostics: readonly Diagnostic[];
}

export function compile(doc: WorkflowDocument, registry: ManifestRegistry): CompiledGraph {
  const diagnostics: Diagnostic[] = [];
  const nodes = new Map<NodeId, CompiledNode>();
  const edges = new Map<EdgeId, Edge>();
  const outgoing = new Map<NodeId, Edge[]>();
  const incoming = new Map<NodeId, Edge[]>();

  const enabled = doc.nodes.filter((n) => !n.disabled);
  const manifests = new Map<NodeId, NodeManifest>();

  for (const node of enabled) {
    const manifest = registry.get(node.type, node.typeVersion);
    if (!manifest) continue; // validateDocument reports this; compile stays quiet
    manifests.set(node.id, manifest);
  }

  // A disabled node is not simply dropped: its edges would dangle and the
  // branch behind it would look unreachable. Edges touching one are removed
  // together with it, which is the behaviour someone toggling a node expects.
  for (const edge of doc.edges) {
    if (!manifests.has(edge.from.node) || !manifests.has(edge.to.node)) continue;
    edges.set(edge.id, edge);
    (outgoing.get(edge.from.node) ?? outgoing.set(edge.from.node, []).get(edge.from.node)!).push(edge);
    (incoming.get(edge.to.node) ?? incoming.set(edge.to.node, []).get(edge.to.node)!).push(edge);
  }

  const scopeEnds = matchScopes(enabled, manifests, outgoing, diagnostics);
  const loopBackEdges = findLoopBackEdges(edges, manifests, diagnostics);
  const scopeChains = resolveScopeChains(enabled, manifests, incoming, loopBackEdges, scopeEnds);

  for (const node of enabled) {
    const manifest = manifests.get(node.id);
    if (!manifest) continue;
    nodes.set(node.id, {
      id: node.id,
      instance: node,
      manifest,
      scopeChain: scopeChains.get(node.id) ?? [],
    });
  }

  const triggers = enabled.filter((n) => manifests.get(n.id)?.trigger).map((n) => n.id);
  const topoOrder = topologicalOrder(nodes, outgoing, loopBackEdges);

  return {
    document: doc,
    nodes,
    edges,
    outgoing,
    incoming,
    triggers,
    loopBackEdges,
    scopeEnds,
    topoOrder,
    diagnostics,
  };
}

/**
 * A loop-back edge is one that closes a cycle INTO a scope start.
 *
 * Every other cycle is a validation error. That restriction is what buys the
 * three properties arbitrary cycles cannot give: a termination bound on every
 * loop, an addressable run per iteration, and a loop you can see on the canvas
 * instead of inferring from a back-edge.
 */
function findLoopBackEdges(
  edges: ReadonlyMap<EdgeId, Edge>,
  manifests: ReadonlyMap<NodeId, NodeManifest>,
  diagnostics: Diagnostic[],
): Set<EdgeId> {
  const loopBack = new Set<EdgeId>();

  // Depth-first search over the graph; an edge to a node currently on the
  // stack closes a cycle.
  const colour = new Map<NodeId, 'white' | 'grey' | 'black'>();
  const adjacency = new Map<NodeId, Edge[]>();
  for (const edge of edges.values()) {
    (adjacency.get(edge.from.node) ?? adjacency.set(edge.from.node, []).get(edge.from.node)!).push(edge);
  }

  const visit = (nodeId: NodeId, stack: NodeId[]): void => {
    colour.set(nodeId, 'grey');
    stack.push(nodeId);
    for (const edge of adjacency.get(nodeId) ?? []) {
      const target = edge.to.node;
      const targetColour = colour.get(target) ?? 'white';
      if (targetColour === 'grey') {
        const manifest = manifests.get(target);
        if (manifest?.scope?.role === 'start') {
          loopBack.add(edge.id);
        } else {
          diagnostics.push({
            severity: 'error',
            code: 'UNSCOPED_CYCLE',
            path: ['edges'],
            message: `Edge ${edge.id} closes a cycle into ${target}, which is not a scope start. Cycles are legal only back into a loop, so that the loop has a termination bound.`,
            quickFix: {
              title: 'Wrap the cycle in a loop scope',
              describe: 'Insert a forEach or while scope; the back edge then targets its start node.',
            },
          });
        }
        continue;
      }
      if (targetColour === 'white') visit(target, stack);
    }
    stack.pop();
    colour.set(nodeId, 'black');
  };

  for (const nodeId of adjacency.keys()) {
    if ((colour.get(nodeId) ?? 'white') === 'white') visit(nodeId, []);
  }
  return loopBack;
}

/**
 * Pair each scope start with its end by walking forward from the start.
 *
 * The pairing is structural rather than declared in the document: a start and
 * an end that drifted out of agreement would be a class of bug the author
 * cannot see, and the author already told us the structure by wiring it.
 */
function matchScopes(
  nodes: readonly NodeInstance[],
  manifests: ReadonlyMap<NodeId, NodeManifest>,
  outgoing: ReadonlyMap<NodeId, readonly Edge[]>,
  diagnostics: Diagnostic[],
): Map<NodeId, NodeId> {
  const pairs = new Map<NodeId, NodeId>();
  const starts = nodes.filter((n) => manifests.get(n.id)?.scope?.role === 'start');

  for (const start of starts) {
    const seen = new Set<NodeId>([start.id]);
    const queue: NodeId[] = [start.id];
    let end: NodeId | undefined;
    let depth = 0;

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of outgoing.get(current) ?? []) {
        const next = edge.to.node;
        if (seen.has(next)) continue;
        seen.add(next);
        const role = manifests.get(next)?.scope?.role;
        if (role === 'start') depth++;
        if (role === 'end') {
          if (depth === 0) {
            end ??= next;
            continue; // do not walk past the end of our own scope
          }
          depth--;
        }
        queue.push(next);
      }
    }

    if (!end) {
      diagnostics.push({
        severity: 'error',
        code: 'SCOPE_UNBALANCED',
        path: ['nodes'],
        message: `Scope ${start.id} has no matching scope end downstream. A loop without an end cannot report a result or terminate.`,
      });
      continue;
    }
    pairs.set(start.id, end);
  }
  return pairs;
}

/**
 * Work out which scopes each node executes inside.
 *
 * The chain is what makes a node run addressable: a node in `loop1[3]/inner[0]`
 * has its own journal entries, its own logs and its own inspectable output,
 * where an engine keyed by node id alone would overwrite the same record on
 * every iteration and lose the history entirely.
 */
function resolveScopeChains(
  nodes: readonly NodeInstance[],
  manifests: ReadonlyMap<NodeId, NodeManifest>,
  incoming: ReadonlyMap<NodeId, readonly Edge[]>,
  loopBackEdges: ReadonlySet<EdgeId>,
  scopeEnds: ReadonlyMap<NodeId, NodeId>,
): Map<NodeId, NodeId[]> {
  const chains = new Map<NodeId, NodeId[]>();
  const endToStart = new Map<NodeId, NodeId>();
  for (const [start, end] of scopeEnds) endToStart.set(end, start);

  const resolve = (nodeId: NodeId, guard: Set<NodeId>): NodeId[] => {
    const cached = chains.get(nodeId);
    if (cached) return cached;
    if (guard.has(nodeId)) return [];
    guard.add(nodeId);

    const inbound = (incoming.get(nodeId) ?? []).filter((e) => !loopBackEdges.has(e.id));
    let chain: NodeId[] = [];
    for (const edge of inbound) {
      const upstream = resolve(edge.from.node, guard);
      const manifest = manifests.get(edge.from.node);
      // Which PORT the edge left by decides whether it entered the scope. A
      // scope start has two: `item` runs the body, `done` fires once the loop
      // is over and belongs to the parent. Treating both as entering puts
      // everything after the loop inside it.
      if (manifest?.scope?.role === 'start' && edge.from.port === 'item') {
        chain = [...upstream, edge.from.node];
      } else if (manifest?.scope?.role === 'start') {
        chain = upstream;
      } else if (manifest?.scope?.role === 'end') {
        // Leaving a scope: drop its start from the chain.
        chain = upstream.slice(0, -1);
      } else {
        chain = upstream;
      }
      if (chain.length > 0) break;
    }

    // A scope end belongs to the scope it closes, so that its own run is
    // addressed inside the iteration it summarises.
    const own = manifests.get(nodeId)?.scope;
    if (own?.role === 'end') {
      const start = endToStart.get(nodeId);
      if (start) chain = chains.get(start) ?? chain;
    }

    chains.set(nodeId, chain);
    return chain;
  };

  for (const node of nodes) resolve(node.id, new Set());
  return chains;
}

/** Kahn's algorithm over the acyclic part of the graph. */
function topologicalOrder(
  nodes: ReadonlyMap<NodeId, CompiledNode>,
  outgoing: ReadonlyMap<NodeId, readonly Edge[]>,
  loopBackEdges: ReadonlySet<EdgeId>,
): NodeId[] {
  const indegree = new Map<NodeId, number>();
  for (const id of nodes.keys()) indegree.set(id, 0);
  for (const [, list] of outgoing) {
    for (const edge of list) {
      if (loopBackEdges.has(edge.id)) continue;
      indegree.set(edge.to.node, (indegree.get(edge.to.node) ?? 0) + 1);
    }
  }

  const ready = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: NodeId[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (loopBackEdges.has(edge.id)) continue;
      const next = (indegree.get(edge.to.node) ?? 1) - 1;
      indegree.set(edge.to.node, next);
      if (next === 0) ready.push(edge.to.node);
    }
  }
  return order;
}

/**
 * The transitive downstream closure of a set of nodes.
 *
 * "Run from here" in the editor: everything downstream re-executes, everything
 * upstream replays its cached output from the previous run's journal. Editing
 * the last node of a twelve-node workflow re-runs one node, not twelve.
 */
export function affectedSubgraph(graph: CompiledGraph, changed: Iterable<NodeId>): Set<NodeId> {
  const affected = new Set<NodeId>(changed);
  const queue = [...affected];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of graph.outgoing.get(id) ?? []) {
      if (affected.has(edge.to.node)) continue;
      affected.add(edge.to.node);
      queue.push(edge.to.node);
    }
  }
  return affected;
}
