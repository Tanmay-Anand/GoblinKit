import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';

import { portHue, portLabel } from '../describe.js';
import { useEditor } from './context.js';

export type PortFlowEdge = Edge<Record<string, never>, 'port'>;

/**
 * A wire. Coloured by the port it leaves — green for true, orange for false —
 * with a pill naming the branch, like the reference's "2 Triggers" labels.
 * During a run the pill shows how many items went through, and a branch that
 * was not taken fades to a dashed line.
 */
export const PortEdge = memo(function PortEdge(props: EdgeProps<PortFlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, source, sourceHandleId } = props;
  const sourceType = useEditor((s) => s.byId[source]?.type ?? '');
  const run = useEditor((s) => s.run.projection.wires[id]);
  const problem = useEditor((s) => s.problems.edges[id]?.[0]);
  const running = useEditor((s) => s.run.projection.status !== 'idle');

  const port = sourceHandleId ?? 'main';
  const hue = problem ? '#d24c4c' : portHue(port);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
    offset: 18,
  });

  const name = portLabel(sourceType, port);
  const pruned = run?.status === 'pruned' || (running && !run);
  const text = run?.status === 'delivered' ? `${name ? `${name} · ` : ''}${run.items} item${run.items === 1 ? '' : 's'}` : name;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={`gk-wire${selected ? ' is-selected' : ''}${pruned ? ' is-pruned' : ''}${run?.status === 'delivered' ? ' is-live' : ''}`}
        style={{ stroke: selected ? '#1f8fd6' : hue }}
        interactionWidth={18}
      />
      {text || problem ? (
        <EdgeLabelRenderer>
          <div
            className={`gk-wire-pill nodrag nopan${pruned ? ' is-pruned' : ''}${problem ? ' has-error' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, ['--port' as string]: hue }}
            title={problem?.message}
          >
            <i />
            {problem ? 'Needs fixing' : text}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});
