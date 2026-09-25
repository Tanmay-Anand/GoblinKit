import { useEffect } from 'react';

import type { RunRecord } from '@goblin/api/protocol';

import { Icon } from './icons.js';
import { useEditor, useEditorStore } from './context.js';

/**
 * The run on screen and the ones before it — the reference's "View Metrics"
 * panel, for a workflow: an overview of one run in tiles, then the history.
 */
export function RunsPanel() {
  const store = useEditorStore();
  const run = useEditor((s) => s.run);
  const history = useEditor((s) => s.history);

  useEffect(() => {
    void store.getState().refreshHistory();
  }, [store]);

  const record = run.record;
  const p = run.projection;
  const live = p.status === 'running' || p.status === 'waiting' || run.starting;

  return (
    <aside className="gk-panel gk-runs" aria-label="Runs">
      <header className="gk-panel-head">
        <div>
          <h2>Runs</h2>
          <p className="gk-panel-sub">What this workflow did, run by run.</p>
        </div>
        <button type="button" className="gk-icon-btn" onClick={() => store.getState().openPanel(null)} aria-label="Close">
          <Icon name="x" />
        </button>
      </header>

      <div className="gk-panel-scroll">
        {run.runId ? (
          <section className="gk-run-overview">
            <div className="gk-run-overview-head">
              <StatusPill status={live ? 'running' : (record?.status ?? p.status)} />
              <span className="gk-muted">{record ? describeWhen(record) : 'Starting…'}</span>
            </div>
            <div className="gk-tiles">
              <Tile label="Boxes run" value={p.counters.nodesRun} />
              <Tile label="Items produced" value={p.counters.itemsProcessed} />
              <Tile label="Errors" value={p.counters.errors} tone={p.counters.errors ? 'bad' : undefined} />
              <Tile label="Retries" value={p.counters.retries} />
            </div>
            {p.error ? (
              <p className="gk-run-error">
                <Icon name="alert" size={14} /> {p.error}
              </p>
            ) : null}
            {p.output?.items.length ? (
              <>
                <h3 className="gk-subhead">Result · {p.output.items.length} item{p.output.items.length === 1 ? '' : 's'}</h3>
                <pre className="gk-json gk-json-short">{JSON.stringify(p.output.items.map((i) => i.data), null, 2)}</pre>
              </>
            ) : null}
            {run.logs.length ? (
              <>
                <h3 className="gk-subhead">Log</h3>
                <ul className="gk-logs">
                  {run.logs.map((l, i) => (
                    <li key={i}>
                      <span className="gk-log-node">{l.node}</span> {l.message}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <button type="button" className="gk-btn-outline gk-btn-block" onClick={() => store.getState().closeRunView()}>
              Back to editing
            </button>
          </section>
        ) : null}

        <h3 className="gk-subhead">History</h3>
        {history.length === 0 ? (
          <p className="gk-empty">No runs yet. Press Run to try this workflow.</p>
        ) : (
          <ul className="gk-history">
            {history.map((r) => (
              <li key={r.runId}>
                <button
                  type="button"
                  className={`gk-history-row${r.runId === run.runId ? ' is-current' : ''}`}
                  onClick={() => void store.getState().viewRun(r.runId)}
                >
                  <StatusDot status={r.status} />
                  <span className="gk-history-when">{clockTime(r.startedAt)}</span>
                  <span className="gk-muted">{duration(r)}</span>
                  <span className="gk-history-count">{r.counters ? `${r.counters.nodesRun} boxes` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'bad' | undefined }) {
  return (
    <div className={`gk-tile-stat${tone === 'bad' ? ' is-bad' : ''}`}>
      <span className="gk-tile-label">{label}</span>
      <span className="gk-tile-value">{value.toLocaleString()}</span>
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  running: 'Running',
  waiting: 'Waiting',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  pending: 'Starting',
  idle: 'Not run',
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`gk-status gk-status-${status}`}>{STATUS_TEXT[status] ?? status}</span>;
}

function StatusDot({ status }: { status: string }) {
  return <span className={`gk-dot gk-status-${status}`} aria-label={STATUS_TEXT[status] ?? status} />;
}

function clockTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function duration(r: RunRecord): string {
  if (!r.finishedAt) return 'still going';
  const ms = r.finishedAt - r.startedAt;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function describeWhen(r: RunRecord): string {
  return `Started ${clockTime(r.startedAt)}${r.finishedAt ? ` · took ${duration(r)}` : ''}`;
}
