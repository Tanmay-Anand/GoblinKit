import { memo, type CSSProperties } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

import type { PortSpec } from '@goblin/spec';

import { describeType, portHue, portLabel, summarize } from '../describe.js';
import { rotationOf, sidesFor, type Side } from '../rotation.js';
import type { BoxRunView } from '../run/projection.js';
import { Icon } from './icons.js';
import { useEditor, useEditorStore } from './context.js';

export type BoxFlowNode = Node<Record<string, never>, 'box'>;

const POSITION: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

/**
 * Where the i-th of n dots sits along a side. Along the top and bottom the
 * dots spread across the width; down the sides they spread below the title
 * bar, so each lines up with its name inside the card.
 */
function spread(side: Side, i: number, n: number): CSSProperties {
  const frac = (i + 1) / (n + 1);
  return side === 'top' || side === 'bottom'
    ? { left: `${frac * 100}%` }
    : { top: `calc(34px + (100% - 34px) * ${frac})` };
}

/**
 * One box on the canvas: a dark title bar, what it is set to do, and — during
 * a run — what it did. Modelled on the reference: charcoal header with a
 * chevron, white body, a "+" to grow the flow from here.
 *
 * A turned box moves its dots to other sides; the card, its title and its
 * text always stay upright and readable.
 */
export const BoxNode = memo(function BoxNode({ id, selected }: NodeProps<BoxFlowNode>) {
  const store = useEditorStore();
  const node = useEditor((s) => s.byId[id]);
  const registry = useEditor((s) => s.registry);
  const problems = useEditor((s) => s.problems.nodes[id]);
  const run = useEditor((s) => s.run.projection.boxes[id]);
  const running = useEditor((s) => s.run.projection.status !== 'idle');
  const trigger = useEditor((s) => s.triggers[id]);
  const active = useEditor((s) => s.activation?.active === true);

  if (!node) return null;
  const manifest = registry.get(node.type, node.typeVersion);
  const look = manifest ? describeType(manifest) : undefined;
  const inputs = manifest?.ports.inputs ?? [];
  const outputs = manifest?.ports.outputs ?? [];
  const collapsed = node.ui?.collapsed === true;
  const errors = problems?.filter((d) => d.severity === 'error') ?? [];
  const warnings = problems?.filter((d) => d.severity !== 'error') ?? [];
  const sides = sidesFor(rotationOf(node));
  // Port names sit inside the card along the output side. A collapsed card is
  // too short to hold them anywhere but the bottom row, so there they go quiet.
  const showPortNames =
    (outputs.length > 1 || outputs.some((p) => p.id !== 'main')) && (!collapsed || sides.output === 'bottom');

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
    `faces-${sides.output}`,
    showPortNames ? 'has-port-names' : '',
    selected ? 'is-selected' : '',
    errors.length ? 'has-error' : '',
    run ? `run-${run.status}` : running ? 'run-untouched' : '',
    node.disabled ? 'is-disabled' : '',
  ].join(' ');

  const handle = (port: PortSpec, i: number, list: PortSpec[], kind: 'in' | 'out') => {
    const side = kind === 'in' ? sides.input : sides.output;
    const name = portLabel(node.type, port.id);
    return (
      <Handle
        key={port.id}
        type={kind === 'in' ? 'target' : 'source'}
        position={POSITION[side]}
        id={port.id}
        className={`gk-handle gk-handle-${kind}`}
        style={{ ...spread(side, i, list.length), ...(kind === 'out' ? { ['--port' as string]: portHue(port.id) } : {}) }}
        title={name || (kind === 'in' ? 'input' : 'output')}
        aria-label={`${kind === 'in' ? 'Input' : 'Output'}${name ? `: ${name}` : ''}`}
      />
    );
  };

  // Names down a side need room: a Switch's five outputs would crowd a standard-height card.
  const sideways = sides.output === 'left' || sides.output === 'right';
  const minHeight = showPortNames && sideways ? 34 + 22 * (outputs.length + 1) : undefined;

  return (
    <div className={classes} style={{ ['--hue' as string]: look?.category.hue ?? '#6b7280', ...(minHeight ? { minHeight } : {}) }}>
      {inputs.map((port, i) => handle(port, i, inputs, 'in'))}

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
          <div className="gk-box-summary" title={summarize(node, manifest, trigger)}>
            {summarize(node, manifest, trigger)}
          </div>
          {trigger?.problem ? <div className="gk-box-error">{trigger.problem}</div> : null}
          {active && trigger?.nextRunAt ? (
            <div className="gk-box-next">
              <Icon name="clock" size={12} /> Next run {nextTime(trigger.nextRunAt)}
            </div>
          ) : null}
          {active && trigger?.kind === 'webhook' ? (
            <div className="gk-box-next">
              <span className="gk-live-dot" aria-hidden="true" /> Listening
            </div>
          ) : null}
          {warnings.length > 0 && !errors.length ? <div className="gk-box-warn">{warnings[0]!.message}</div> : null}
          {errors.length > 0 ? <div className="gk-box-error">{errors[0]!.message}</div> : null}
        </div>
      )}

      {run ? <RunStrip run={run} /> : null}

      <div className="gk-box-foot">
        {outputs.length > 0 ? (
          <button type="button" className="gk-box-grow nodrag" onClick={grow} aria-label="Add a box after this one" title="Add a box after this one">
            <Icon name="plus" size={14} />
          </button>
        ) : null}
      </div>

      {showPortNames ? (
        <div className={`gk-box-ports gk-ports-${sides.output}`} aria-hidden="true">
          {outputs.map((port, i) => (
            <span key={port.id} className="gk-port-name" style={{ ...spread(sides.output, i, outputs.length), color: portHue(port.id) }}>
              {portLabel(node.type, port.id)}
            </span>
          ))}
        </div>
      ) : null}

      {outputs.map((port, i) => handle(port, i, outputs, 'out'))}
    </div>
  );
});


function nextTime(ms: number): string {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

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
