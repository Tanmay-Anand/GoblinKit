/**
 * Every change to a workflow on the canvas is one of these commands.
 *
 * The canvas never edits the document directly; it asks for a command, and
 * `applyCommand` returns the next document. That single path is what makes
 * undo coherent across the canvas and the settings panel, and it is the unit
 * a future "build this for me" feature would emit instead of rewriting JSON
 * (§15.2). Pure: no React, no store, no I/O.
 */

import type { Edge, NodeInstance, WorkflowDocument, XY } from '@goblin/spec';

import { rotationOf, turn } from '../rotation.js';

/** Fields a patch may change. Setting one to undefined removes it. */
export type NodePatch = { [K in 'label' | 'config' | 'policy' | 'ui' | 'disabled']?: NodeInstance[K] | undefined };

export type DocumentCommand =
  /** Add a box, and optionally the wires that connect it in the same step. */
  | { kind: 'AddNode'; node: NodeInstance; edges?: Edge[] }
  /** Remove boxes (with every wire touching them) and wires. */
  | { kind: 'RemoveElements'; nodeIds: string[]; edgeIds: string[] }
  | { kind: 'MoveNodes'; moves: { id: string; to: XY }[] }
  | { kind: 'Connect'; edge: Edge }
  | { kind: 'UpdateNode'; nodeId: string; patch: NodePatch }
  /** Turn boxes a quarter clockwise (90) or anticlockwise (-90), as one step. */
  | { kind: 'RotateNodes'; nodeIds: string[]; by: 90 | -90 }
  | { kind: 'RenameWorkflow'; name: string };

export function applyCommand(doc: WorkflowDocument, cmd: DocumentCommand): WorkflowDocument {
  switch (cmd.kind) {
    case 'AddNode':
      return { ...doc, nodes: [...doc.nodes, cmd.node], edges: [...doc.edges, ...(cmd.edges ?? [])] };

    case 'RemoveElements': {
      const nodes = new Set(cmd.nodeIds);
      const edges = new Set(cmd.edgeIds);
      return {
        ...doc,
        nodes: doc.nodes.filter((n) => !nodes.has(n.id)),
        edges: doc.edges.filter((e) => !edges.has(e.id) && !nodes.has(e.from.node) && !nodes.has(e.to.node)),
      };
    }

    case 'MoveNodes': {
      const to = new Map(cmd.moves.map((m) => [m.id, m.to]));
      return {
        ...doc,
        nodes: doc.nodes.map((n) => {
          const position = to.get(n.id);
          return position ? { ...n, ui: { ...n.ui, position } } : n;
        }),
      };
    }

    case 'Connect':
      return { ...doc, edges: [...doc.edges, cmd.edge] };

    case 'UpdateNode':
      return {
        ...doc,
        nodes: doc.nodes.map((n) => (n.id === cmd.nodeId ? withPatch(n, cmd.patch) : n)),
      };

    case 'RotateNodes': {
      const ids = new Set(cmd.nodeIds);
      return {
        ...doc,
        nodes: doc.nodes.map((n) => {
          if (!ids.has(n.id)) return n;
          const rotation = turn(rotationOf(n), cmd.by);
          // 0 is the default, so it is dropped rather than stored.
          const { rotation: _old, ...ui } = n.ui ?? {};
          return { ...n, ui: rotation === 0 ? ui : { ...ui, rotation } };
        }),
      };
    }

    case 'RenameWorkflow':
      return { ...doc, name: cmd.name };
  }
}

/** Apply a patch; a key set to undefined is removed, which exactOptionalPropertyTypes needs spelled out. */
function withPatch(node: NodeInstance, patch: NodePatch): NodeInstance {
  const next: Record<string, unknown> = { ...node };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as unknown as NodeInstance;
}

/**
 * A readable, stable id for a new box: "httpRequest", "httpRequest2", …
 *
 * Readable because people type it in expressions — `{{ $node['httpRequest'] }}`
 * — and stable because it never changes when the box is renamed.
 */
export function newNodeId(doc: WorkflowDocument, title: string): string {
  const base =
    title
      .replace(/[^A-Za-z0-9 ]+/g, ' ')
      .trim()
      .split(/\s+/)
      .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
      .join('') || 'box';
  const taken = new Set(doc.nodes.map((n) => n.id));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

export function newEdgeId(doc: WorkflowDocument): string {
  const taken = new Set(doc.edges.map((e) => e.id));
  let i = doc.edges.length + 1;
  while (taken.has(`e${i}`)) i++;
  return `e${i}`;
}
