import { useEffect, useState } from 'react';

import { fieldApplies, type ConfigField, type Envelope, type JsonValue, type NodeInstance, type NodePolicy, type OnErrorBehaviour } from '@goblin/spec';

import type { TriggerStatus } from '@goblin/api/protocol';

import type { NodePatch } from '../document/commands.js';
import { describeType, portLabel } from '../describe.js';
import { rotationOf, SIDE_LABEL, sidesFor } from '../rotation.js';
import { lowerFirst } from './text.js';
import { Icon } from './icons.js';
import { useEditor, useEditorStore } from './context.js';

type Tab = 'settings' | 'input' | 'output';

/**
 * A box's settings, generated from its manifest — no per-box form code
 * (§15.4). Every keystroke is a command, coalesced so undo takes back a
 * whole edit. The Input and Output tabs show what the box saw and produced
 * in the run on screen.
 */
export function SettingsPanel({ nodeId, tab }: { nodeId: string; tab: Tab }) {
  const store = useEditorStore();
  const node = useEditor((s) => s.byId[nodeId]);
  const registry = useEditor((s) => s.registry);
  const problems = useEditor((s) => s.problems.nodes[nodeId]);
  const run = useEditor((s) => s.run.projection.boxes[nodeId]);
  const trigger = useEditor((s) => s.triggers[nodeId]);
  const active = useEditor((s) => s.activation?.active === true);

  if (!node) return null;
  const manifest = registry.get(node.type, node.typeVersion);
  const look = manifest ? describeType(manifest) : undefined;
  const setTab = (t: Tab) => store.getState().openPanel({ kind: 'box', nodeId, tab: t });
  const patch = (p: NodePatch, key: string) => store.getState().dispatch({ kind: 'UpdateNode', nodeId, patch: p }, `${nodeId}:${key}`);

  const setConfig = (name: string, value: JsonValue | undefined) => {
    const config = { ...node.config };
    if (value === undefined) delete config[name];
    else config[name] = value;
    patch({ config }, `config.${name}`);
  };

  const hasErrorPort = manifest?.ports.outputs.some((p) => p.id === 'error') ?? false;
  const onError: OnErrorBehaviour = node.policy?.onError ?? 'fail';
  const attempts = node.policy?.retry?.maxAttempts ?? manifest?.defaults?.policy?.retry?.maxAttempts ?? 1;
  const setPolicy = (next: Partial<NodePolicy>, key: string) => patch({ policy: { ...node.policy, ...next } }, `policy.${key}`);

  return (
    <aside className="gk-panel gk-settings" aria-label={`Settings for ${node.label ?? node.id}`}>
      <header className="gk-panel-head">
        <span className="gk-tile gk-tile-lg" style={{ color: look?.category.hue, background: look?.category.tint }}>
          {look ? <Icon name={look.glyph} size={18} /> : null}
        </span>
        <div className="gk-settings-name">
          <input
            id={`gk-label-${nodeId}`}
            className="gk-title-input"
            value={node.label ?? ''}
            placeholder={manifest?.title ?? 'Box name'}
            onChange={(e) => patch({ label: e.target.value || undefined }, 'label')}
            aria-label="Box name"
          />
          <p className="gk-panel-sub">
            {manifest?.title ?? node.type} · <code title="Use this id in expressions">{`$node['${node.id}']`}</code>
          </p>
        </div>
        <button type="button" className="gk-icon-btn" onClick={() => store.getState().openPanel(null)} aria-label="Close">
          <Icon name="x" />
        </button>
      </header>

      <nav className="gk-tabs" role="tablist">
        {(['settings', 'input', 'output'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)}>
            {t === 'settings' ? 'Settings' : t === 'input' ? 'Input' : 'Output'}
            {t !== 'settings' && run ? <span className="gk-tab-dot" /> : null}
          </button>
        ))}
      </nav>

      <div className="gk-panel-scroll">
        {tab === 'settings' ? (
          <>
            {problems?.length ? (
              <ul className="gk-problems">
                {problems.map((d, i) => (
                  <li key={i} className={d.severity === 'error' ? 'is-error' : 'is-warning'}>
                    <Icon name="alert" size={14} />
                    {d.message}
                  </li>
                ))}
              </ul>
            ) : null}

            {manifest?.description ? <p className="gk-help">{manifest.description}</p> : null}

            {trigger ? <TriggerInfo trigger={trigger} active={active} /> : null}

            {(manifest?.config?.fields ?? []).filter((f, _i, all) => fieldApplies(f, node.config, all)).map((field) => (
              <Field key={field.name} nodeId={nodeId} field={field} value={node.config[field.name]} onChange={(v) => setConfig(field.name, v)} />
            ))}
            {!manifest?.config?.fields?.length ? <p className="gk-help">This box has nothing to set up.</p> : null}

            <div className="gk-field">
              <span className="gk-field-label" id={`gk-facing-${nodeId}`}>
                Faces
              </span>
              <div className="gk-inline" role="group" aria-labelledby={`gk-facing-${nodeId}`}>
                <button type="button" className="gk-btn-outline gk-btn-icon" onClick={() => store.getState().rotate(-90, [nodeId])} aria-label="Rotate left" title="Rotate left (Shift+R)">
                  <Icon name="rotateLeft" size={15} />
                </button>
                <button type="button" className="gk-btn-outline gk-btn-icon" onClick={() => store.getState().rotate(90, [nodeId])} aria-label="Rotate right" title="Rotate right (R)">
                  <Icon name="rotateRight" size={15} />
                </button>
                <span className="gk-muted">{facing(node)}</span>
              </div>
            </div>

            {manifest && !manifest.trigger && !manifest.scope && node.type !== 'core.wait' ? (
              <fieldset className="gk-fieldset">
                <legend>If it fails</legend>
                <label className="gk-field">
                  <span className="gk-field-label">Try up to</span>
                  <span className="gk-inline">
                    <input
                      id={`gk-attempts-${nodeId}`}
                      type="number"
                      min={1}
                      max={10}
                      value={attempts}
                      onChange={(e) => {
                        const n = Math.max(1, Math.min(10, Number(e.target.value) || 1));
                        const base = node.policy?.retry ?? manifest.defaults?.policy?.retry ?? { maxAttempts: 1, backoffMs: 500, maxBackoffMs: 30_000 };
                        setPolicy({ retry: { ...base, maxAttempts: n } }, 'retry');
                      }}
                    />
                    <span className="gk-muted">times, waiting longer between each</span>
                  </span>
                </label>
                <label className="gk-field">
                  <span className="gk-field-label">Then</span>
                  <select id={`gk-onerror-${nodeId}`} value={onError} onChange={(e) => setPolicy({ onError: e.target.value as OnErrorBehaviour }, 'onError')}>
                    <option value="fail">Stop the whole run</option>
                    <option value="continue">Skip this branch and carry on</option>
                    {hasErrorPort ? <option value="route">Send the error down the “error” wire</option> : null}
                  </select>
                </label>
              </fieldset>
            ) : null}

            <div className="gk-panel-actions">
              <button
                type="button"
                className="gk-btn-danger"
                onClick={() => {
                  store.getState().select({ nodes: [nodeId], edges: [] });
                  store.getState().removeSelected();
                }}
              >
                <Icon name="trash" size={14} /> Delete box
              </button>
            </div>
          </>
        ) : (
          <DataView
            envelopes={tab === 'input' ? run?.lastInput : run?.lastOutput}
            nodeType={node.type}
            empty={
              run?.status === 'skipped'
                ? 'This box was skipped in this run, so it had no data.'
                : tab === 'input'
                  ? 'Nothing has reached this box yet. Press Run to see what it receives.'
                  : 'This box has not produced anything yet. Press Run to see its output.'
            }
            note={run && run.starts > 1 ? `Showing the last of ${run.starts} passes.` : undefined}
          />
        )}
      </div>
    </aside>
  );
}

/** Where a Schedule or Webhook box stands: its URL to copy, or its next run. */
function TriggerInfo({ trigger, active }: { trigger: TriggerStatus; active: boolean }) {
  const [copied, setCopied] = useState(false);
  if (trigger.kind === 'webhook' && trigger.url) {
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(trigger.url!);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        // No clipboard access: select the text so Ctrl+C copies it.
        document.getElementById(`gk-hook-url-${trigger.nodeId}`)?.focus();
      }
    };
    return (
      <div className="gk-field">
        <label className="gk-field-label" htmlFor={`gk-hook-url-${trigger.nodeId}`}>
          URL to call
        </label>
        <span className="gk-inline gk-copy-row">
          <input id={`gk-hook-url-${trigger.nodeId}`} className="gk-mono" readOnly value={trigger.url} onFocus={(e) => e.target.select()} />
          <button type="button" className="gk-btn-outline" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
        <span className="gk-field-hint">
          {active
            ? `Listening for ${lowerFirst(trigger.description)} from programs on this computer.`
            : 'Answers only while the workflow is active. Press Activate to switch it on.'}
        </span>
      </div>
    );
  }
  if (trigger.kind === 'schedule') {
    return (
      <p className={`gk-trigger-note${trigger.problem ? ' is-problem' : ''}`}>
        {trigger.problem
          ? trigger.problem
          : active && trigger.nextRunAt
            ? `Next run: ${new Date(trigger.nextRunAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
            : `${trigger.description}, once the workflow is active.`}
        {trigger.lastError ? <span className="gk-trigger-error"> {trigger.lastError}</span> : null}
      </p>
    );
  }
  return null;
}

function Field({
  nodeId,
  field,
  value,
  onChange,
}: {
  nodeId: string;
  field: ConfigField;
  value: JsonValue | undefined;
  onChange: (v: JsonValue | undefined) => void;
}) {
  const id = `gk-field-${nodeId}-${field.name}`;
  const label = field.label ?? humanize(field.name);
  const current = value ?? field.default;
  // "Required" is a property of the control, not part of its name: the
  // asterisk is for eyes, aria-required is for screen readers.
  const req = field.required ? { 'aria-required': true as const } : {};

  const control = (() => {
    switch (field.type) {
      case 'boolean':
        return (
          <label className="gk-switch">
            <input id={id} {...req} type="checkbox" checked={current === true} onChange={(e) => onChange(e.target.checked)} />
            <span>{current === true ? 'On' : 'Off'}</span>
          </label>
        );
      case 'number':
        return (
          <input
            id={id}
            {...req}
            type="number"
            value={typeof current === 'number' ? current : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
        );
      case 'select':
        return (
          <select id={id} {...req} value={String(current ?? '')} onChange={(e) => onChange(e.target.value)}>
            {(field.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        );
      case 'json':
        return <JsonField id={id} required={field.required === true} value={current} onChange={onChange} />;
      case 'expression':
      case 'string':
      default:
        return (
          <input
            id={id}
            {...req}
            className={field.type === 'expression' ? 'gk-mono' : undefined}
            value={typeof current === 'string' ? current : current === undefined ? '' : JSON.stringify(current)}
            placeholder={field.type === 'expression' ? 'Type a value, or {{ $json.field }}' : ''}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
          />
        );
    }
  })();

  return (
    <div className="gk-field">
      <label className="gk-field-label" htmlFor={id}>
        {label}
        {field.required ? <span className="gk-required" aria-hidden="true">*</span> : null}
      </label>
      {control}
      {field.description ? <span className="gk-field-hint">{field.description}</span> : null}
    </div>
  );
}

/**
 * JSON is edited as text and committed only when it parses, so a half-typed
 * object never reaches the document. Undo from elsewhere resets the text.
 */
function JsonField({
  id,
  required,
  value,
  onChange,
}: {
  id: string;
  required: boolean;
  value: JsonValue | undefined;
  onChange: (v: JsonValue | undefined) => void;
}) {
  const pretty = value === undefined ? '' : JSON.stringify(value, null, 2);
  const [text, setText] = useState(pretty);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The document changed underneath (undo, or another field): follow it,
    // unless the text already means the same thing.
    try {
      if (text.trim() && JSON.stringify(JSON.parse(text)) === JSON.stringify(value)) return;
    } catch {
      /* the text is mid-edit; fall through and replace it */
    }
    if (text.trim() === '' && value === undefined) return;
    setText(pretty);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pretty]);

  return (
    <>
      <textarea
        id={id}
        aria-required={required || undefined}
        className="gk-mono"
        rows={Math.min(10, Math.max(3, text.split('\n').length))}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) {
            setError(null);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value) as JsonValue);
            setError(null);
          } catch (err) {
            setError(`Not valid JSON yet: ${(err as Error).message}`);
          }
        }}
      />
      {error ? <span className="gk-field-error">{error}</span> : null}
    </>
  );
}

function DataView({
  envelopes,
  nodeType,
  empty,
  note,
}: {
  envelopes: Record<string, Envelope> | undefined;
  nodeType: string;
  empty: string;
  note: string | undefined;
}) {
  const ports = Object.entries(envelopes ?? {});
  if (!ports.length) return <p className="gk-empty">{empty}</p>;
  return (
    <div className="gk-data">
      {note ? <p className="gk-help">{note}</p> : null}
      {ports.map(([port, env]) => (
        <section key={port}>
          <h3>
            {portLabel(nodeType, port) || (port === 'main' ? 'Items' : port)}
            <span className="gk-muted"> · {env.items.length} item{env.items.length === 1 ? '' : 's'}</span>
          </h3>
          <pre className="gk-json">{JSON.stringify(env.items.map((i) => i.data), null, 2)}</pre>
        </section>
      ))}
    </div>
  );
}

/** "In at the top, out at the bottom" — which way the box faces, in words. */
function facing(node: NodeInstance): string {
  const { input, output } = sidesFor(rotationOf(node));
  return `In at ${SIDE_LABEL[input]}, out at ${SIDE_LABEL[output]}`;
}

function humanize(name: string): string {
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/Ms$/, ' (ms)');
  return spaced[0]!.toUpperCase() + spaced.slice(1).toLowerCase().replace('(ms)', '(ms)');
}
