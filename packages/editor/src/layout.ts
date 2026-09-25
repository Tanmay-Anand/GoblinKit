import { Graph, layout } from '@dagrejs/dagre';

import type { WorkflowDocument, XY } from '@goblin/spec';

import { dominantRankdir } from './rotation.js';

export const BOX_WIDTH = 248;
export const BOX_HEIGHT = 112;

/**
 * Tidy the canvas in the direction the flow runs: top to bottom by default,
 * or whichever way most boxes have been turned to face.
 *
 * Runs only when asked (§15.6). Layout that rearranges boxes while someone is
 * placing them fights the person, which is worse than no layout at all.
 * Returns moves rather than a document, so it goes through the same command
 * path as a drag and can be undone the same way.
 */
export function tidyLayout(doc: WorkflowDocument): { id: string; to: XY }[] {
  const g = new Graph();
  g.setGraph({ rankdir: dominantRankdir(doc), nodesep: 56, ranksep: 64, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of doc.nodes) {
    g.setNode(n.id, { width: BOX_WIDTH, height: n.ui?.collapsed ? 48 : BOX_HEIGHT });
  }
  for (const e of doc.edges) g.setEdge(e.from.node, e.to.node);
  layout(g);

  return doc.nodes.map((n) => {
    const p = g.node(n.id) as { x: number; y: number; height: number };
    // dagre gives centres; the canvas positions boxes by their top-left corner.
    return { id: n.id, to: { x: Math.round(p.x - BOX_WIDTH / 2), y: Math.round(p.y - p.height / 2) } };
  });
}
