import { useEffect, useState } from 'react';

import type { WorkflowSummary } from '@goblin/api/protocol';

import { api } from './api.js';

/** Where the app opens: your workflows, and a button to start a new one. */
export function WorkflowList({ logoUrl, onOpen }: { logoUrl: string; onOpen: (id: string) => void }) {
  const [items, setItems] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => api.listWorkflows().then(setItems, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    setCreating(true);
    try {
      const doc = await api.createWorkflow('Untitled workflow');
      onOpen(doc.id);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteWorkflow(id);
      setConfirming(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="gk-home">
      <header className="gk-home-bar">
        <img src={logoUrl} alt="" width={44} />
        <span className="gk-home-brand">GoblinKit</span>
        <span className="gk-home-local">Local · just you</span>
      </header>

      <main className="gk-home-main">
        <div className="gk-home-head">
          <div>
            <h1>Workflows</h1>
            <p>Pick boxes, connect them, press Run. Everything is saved in the workspace folder on this machine.</p>
          </div>
          <button type="button" className="gk-app-primary" onClick={() => void create()} disabled={creating}>
            {creating ? 'Creating…' : 'New workflow'}
          </button>
        </div>

        {error ? <p className="gk-home-error">{error}</p> : null}

        {items === null ? (
          <p className="gk-home-muted">Loading…</p>
        ) : items.length === 0 ? (
          <div className="gk-home-empty">
            <h2>No workflows yet</h2>
            <p>Create one to open an empty canvas with a Start box on it.</p>
          </div>
        ) : (
          <ul className="gk-home-list">
            {items.map((w) => (
              <li key={w.id} className="gk-home-row">
                {/* Named by the workflow alone; the description is read as its description. */}
                <button
                  type="button"
                  className="gk-home-open"
                  onClick={() => onOpen(w.id)}
                  aria-label={w.name}
                  {...(w.description ? { 'aria-describedby': `desc-${w.id}` } : {})}
                >
                  <span className="gk-home-name">
                    {w.name}
                    {w.active ? <span className="gk-home-active">Active</span> : null}
                  </span>
                  {w.description ? (
                    <span className="gk-home-desc" id={`desc-${w.id}`}>
                      {w.description}
                    </span>
                  ) : null}
                </button>
                <span className="gk-home-meta">
                  {w.boxes} box{w.boxes === 1 ? '' : 'es'}
                </span>
                <span className="gk-home-meta">Edited {relative(w.updatedAt)}</span>
                {confirming === w.id ? (
                  <span className="gk-home-confirm">
                    Delete for good?
                    <button type="button" className="gk-home-danger" onClick={() => void remove(w.id)}>
                      Delete
                    </button>
                    <button type="button" className="gk-home-plain" onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <button type="button" className="gk-home-plain" onClick={() => setConfirming(w.id)} aria-label={`Delete ${w.name}`}>
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function relative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
