/**
 * Turning a box: which sides its wires attach to, and which way its flow runs.
 *
 * A turn moves the attachment points around the card clockwise; the card and
 * its text stay upright, so a turned box is still readable. Pure, so the
 * canvas, box placement and Tidy up all agree on what a rotation means.
 */

import type { NodeInstance, Rotation, WorkflowDocument, XY } from '@goblin/spec';

export type Side = 'top' | 'right' | 'bottom' | 'left';

const CLOCKWISE: Side[] = ['top', 'right', 'bottom', 'left'];

export function rotationOf(node: NodeInstance | undefined): Rotation {
  return node?.ui?.rotation ?? 0;
}

/** Turn by a quarter, either way, wrapping round: 270 + 90 is 0. */
export function turn(rotation: Rotation, by: 90 | -90): Rotation {
  return (((rotation + by) % 360) + 360) % 360 as Rotation;
}

/** Where wires come in and go out, for a box at this rotation. */
export function sidesFor(rotation: Rotation): { input: Side; output: Side } {
  const steps = rotation / 90;
  return { input: CLOCKWISE[steps % 4]!, output: CLOCKWISE[(steps + 2) % 4]! };
}

/** The direction a box's output side points: where the next box belongs. */
export function flowDirection(rotation: Rotation): XY {
  switch (sidesFor(rotation).output) {
    case 'bottom':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    case 'top':
      return { x: 0, y: -1 };
    case 'right':
      return { x: 1, y: 0 };
  }
}

/**
 * The layout direction for Tidy up: whichever way most boxes face.
 * A flow turned to run left to right should tidy left to right.
 */
export function dominantRankdir(doc: WorkflowDocument): 'TB' | 'RL' | 'BT' | 'LR' {
  const counts = new Map<Rotation, number>();
  for (const n of doc.nodes) counts.set(rotationOf(n), (counts.get(rotationOf(n)) ?? 0) + 1);
  let best: Rotation = 0;
  for (const [r, c] of counts) if (c > (counts.get(best) ?? 0)) best = r;
  return ({ 0: 'TB', 90: 'RL', 180: 'BT', 270: 'LR' } as const)[best];
}

export const SIDE_LABEL: Record<Side, string> = { top: 'the top', right: 'the right', bottom: 'the bottom', left: 'the left' };
