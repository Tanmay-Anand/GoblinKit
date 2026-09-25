import type { ManifestRegistry, WorkflowDocument } from '@goblin/spec';

export interface Wire {
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

/**
 * Can this wire be drawn? Returns the reason it cannot, or null.
 *
 * Checked while the wire is being dragged, so a bad connection is refused on
 * the spot with a sentence, instead of being accepted and turning into a
 * validation error later. Anything subtler than the rules here is left to
 * the validator, which runs on every change and marks the box.
 */
export function whyNotConnect(doc: WorkflowDocument, registry: ManifestRegistry, wire: Wire): string | null {
  if (wire.source === wire.target) return 'A box cannot be wired to itself.';

  const source = doc.nodes.find((n) => n.id === wire.source);
  const target = doc.nodes.find((n) => n.id === wire.target);
  if (!source || !target) return 'One end of that wire is not on the canvas.';

  const from = registry.get(source.type, source.typeVersion);
  const to = registry.get(target.type, target.typeVersion);
  if (!from || !to) return 'One of these boxes is not a type this app knows.';

  if (!from.ports.outputs.some((p) => p.id === wire.sourcePort)) return `${from.title} has no output called "${wire.sourcePort}".`;
  const input = to.ports.inputs.find((p) => p.id === wire.targetPort);
  if (!input) return to.trigger ? `${to.title} starts a workflow, so nothing can feed into it.` : `${to.title} has no input called "${wire.targetPort}".`;

  const existing = doc.edges.filter((e) => e.to.node === wire.target && e.to.port === wire.targetPort);
  if (existing.some((e) => e.from.node === wire.source && e.from.port === wire.sourcePort)) return 'Those two are already wired.';
  if (input.cardinality === 'one' && existing.length > 0) return `That input of ${to.title} takes only one wire.`;

  // A loop is only legal back into the box that opens it (§5.6); anywhere
  // else it would run forever with nothing to stop it.
  if (reaches(doc, wire.target, wire.source) && to.scope?.role !== 'start') {
    return 'That would make a loop. Use a For each or While box to repeat steps.';
  }
  return null;
}

function reaches(doc: WorkflowDocument, from: string, to: string): boolean {
  const next = new Map<string, string[]>();
  for (const e of doc.edges) next.set(e.from.node, [...(next.get(e.from.node) ?? []), e.to.node]);
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}
