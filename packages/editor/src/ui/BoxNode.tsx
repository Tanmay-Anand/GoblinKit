import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

import { describeType, portHue, portLabel, summarize } from '../describe.js';
import type { BoxRunView } from '../run/projection.js';
import { Icon } from './icons.js';
import { useEditor, useEditorStore } from './context.js';

export type BoxFlowNode = Node<Record<string, never>, 'box'>;

/**
 * One box on the canvas: a dark title bar, what it is set to do, and — during
 * a run — what it did. Modelled on the reference: charcoal header with a
 * chevron, white body, a "+" to grow the flow from here.
 */
export const BoxNode = memo(function BoxNode({ id, selected }: NodeProps<BoxFlowNode>) {
  const store = useEditorStore();
  const node = useEditor((s) => s.byId[id]);
  const registry = useEditor((s) => s.registry);
  const problems = useEditor((s) => s.problems.nodes[id]);
  const run = useEditor((s) => s.run.projection.boxes[id]);
  const running = useEditor((s) => s.run.projection.status !== 'idle');

  if (!node) return null;
  const manifest = registry.get(node.type, node.typeVersion);
  const look = manifest ? describeType(manifest) : undefined;
  const inputs = manifest?.ports.inputs ?? [];
  const outputs = manifest?.ports.outputs ?? [];
  const collapsed = node.ui?.collapsed === true;
  const errors = problems?.filter((d) => d.severity === 'error') ?? [];
  const warnings = problems?.filter((d) => d.severity !== 'error') ?? [];
  const labelledOutputs = outputs.length > 1 || outputs.some((p) => p.id !== 'main');

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    store.getState().dispatch({ kind: 'UpdateNode', nodeId: id, patch: { ui: { ...node.ui, collapsed: !collapsed } } });
  };

  const grow = (e: React.MouseEvent) => {
    e.stopPropagation();
    const port = outputs[0]?.id;
    if (port) store.getState().openPanel({ kind: 'add', from: { node: id, port } });
  };

  const classes = [
    'gk-box',
    selected ? 'is-selected' : '',
    errors.length ? 'has-error' : '',
    run ? `run-${run.status}` : running ? 'run-untouched' : '',
    node.disabled ? 'is-disabled' : '',
  ].join(' ');

  return (
    <div className={classes} style={{ ['--hue' as string]: look?.category.hue ?? '#6b7280' }}>
      {inputs.map((port, i) => (
        <Handle
          key={port.id}
          type="target"
          position={Position.Top}
          id={port.id}
          className="gk-handle gk-handle-in"
          style={{ left: `${((i + 1) / (inputs.length + 1)) * 100}%` }}
          title={portLabel(node.type, port.id) || 'input'}
          aria-label={portLabel(node.type, port.id) ? `Input: ${portLabel(node.type, port.id)}` : 'Input'}
        />
      ))}

      <div className="gk-box-head">
        <span className="gk-box-glyph">{look ? <Icon name={look.glyph} size={13} /> : null}</span>
        <span className="gk-box-title" title={node.label ?? node.id}>
          {node.label ?? manifest?.title ?? node.id}
        </span>
        {errors.length > 0 ? (
          <span className="gk-box-flag" title={errors.map((d) => d.message).join('\n')}>
            {errors.length}
          </span>
        ) : null}
        <button type="button" className="gk-box-toggle nodrag" onClick={toggle} aria-label={collapsed ? 'Show details' : 'Hide details'}>
          <Icon name={collapsed ? 'chevronDown' : 'chevronUp'} size={14} />
        </button>
      </div>

      {collapsed ? null : (
        <div className="gk-box-body">
          <div className="gk-box-kind">{manifest?.title ?? `Unknown box: ${node.type}`}</div>
          <div className="gk-box-summary" title={summarize(node, manifest)}>
            {summarize(node, manifest)}
          </div>
          {warnings.length > 0 && !errors.length ? <div className="gk-box-warn">{warnings[0]!.message}</div> : null}
          {errors.length > 0 ? <div className="gk-box-error">{errors[0]!.message}</div> : null}
        </div>
      )}

      {run ? <RunStrip run={run} /> : null}

      <div className="gk-box-foot">
        <div className="gk-box-ports">
          {labelledOutputs
            ? outputs.map((port, i) => (
                <span
                  key={port.id}
                  className="gk-port-name"
                  style={{ left: `${((i + 1) / (outputs.length + 1)) * 100}%`, color: portHue(port.id) }}
                >
                  {portLabel(node.type, port.id)}
                </span>
              ))
            : null}
        </div>
        {outputs.length > 0 ? (
          <button type="button" className="gk-box-grow nodrag" onClick={grow} aria-label="Add a box after this one" title="Add a box after this one">
            <Icon name="plus" size={14} />
          </button>
        ) : null}
      </div>

      {outputs.map((port, i) => (
        <Handle
          key={port.id}
          type="source"
          position={Position.Bottom}
          id={port.id}
          className="gk-handle gk-handle-out"
          style={{ left: `${((i + 1) / (outputs.length + 1)) * 100}%`, ['--port' as string]: portHue(port.id) }}
          title={portLabel(node.type, port.id) || 'output'}
          aria-label={portLabel(node.type, port.id) ? `Output: ${portLabel(node.type, port.id)}` : 'Output'}
        />
      ))}
    </div>
  );
});

function RunStrip({ run }: { run: BoxRunView }) {
  // A loop's closing box emits nothing itself, so it reports passes alone.
  const done = [
    ...(run.items > 0 || run.starts <= 1 ? [`${run.items} item${run.items === 1 ? '' : 's'}`] : []),
    ...(run.starts > 1 ? [`${run.starts} passes`] : []),
  ].join(' · ');
  switch (run.status) {
    case 'running':
      return (
        <div className="gk-run-strip is-running">
          <Icon name="spinner" size={13} className="gk-spin" />
          Running{run.attempt > 1 ? ` (attempt ${run.attempt})` : ''}…
        </div>
      );
    case 'waiting':
      return run.retrying ? (
        <div className="gk-run-strip is-waiting" title={run.error}>
          <Icon name="clock" size={13} />
          Retrying soon (attempt {run.attempt + 1})…
        </div>
      ) : (
        <div className="gk-run-strip is-waiting">
          <Icon name="clock" size={13} />
          Waiting…
        </div>
      );
    case 'succeeded':
      return (
        <div className="gk-run-strip is-succeeded">
          <Icon name="check" size={13} />
          Done · {done}
        </div>
      );
    case 'failed':
      return (
        <div className="gk-run-strip is-failed" title={run.error}>
          <Icon name="alert" size={13} />
          Failed: {run.error}
        </div>
      );
    case 'skipped':
      return (
        <div className="gk-run-strip is-skipped" title={run.skippedBecause}>
          <Icon name="dash" size={13} />
          Skipped: its branch was not taken
        </div>
      );
  }
}
