import { useEffect, useState, type FormEvent } from 'react';

import type { CredentialTypeManifest } from '@goblin/spec';
import type { CredentialSummary } from '@goblin/api/protocol';

import { api } from './api.js';

type Editing = { mode: 'add' } | { mode: 'replace'; credential: CredentialSummary };

/**
 * Saved sign-in details: tokens, API keys, a Cognito refresh token.
 *
 * Values go in and never come back — the list shows names and types, and
 * replacing a credential means entering its values again. They are encrypted
 * on this machine with a key kept in your profile folder, not the workspace.
 */
export function Credentials({ logoUrl, onBack }: { logoUrl: string; onBack: () => void }) {
  const [items, setItems] = useState<CredentialSummary[] | null>(null);
  const [types, setTypes] = useState<CredentialTypeManifest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = async () => {
    try {
      const [list, kinds] = await Promise.all([api.listCredentials(), api.listCredentialTypes()]);
      setItems(list);
      setTypes(kinds);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const title = (type: string) => types.find((t) => t.type === type)?.title ?? type;

  const remove = async (id: string) => {
    try {
      await api.deleteCredential(id);
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
        <nav className="gk-home-nav" aria-label="Sections">
          <a href="#/" onClick={(e) => (e.preventDefault(), onBack())}>
            Workflows
          </a>
          <a href="#/credentials" aria-current="page">
            Credentials
          </a>
        </nav>
      </header>

      <main className="gk-home-main">
        <div className="gk-home-head">
          <div>
            <h1>Credentials</h1>
            <p>Sign-in details your boxes use. Pick one in a box’s settings; the box never sees the value, only the request it signs.</p>
          </div>
          {editing?.mode !== 'add' ? (
            <button type="button" className="gk-app-primary" onClick={() => setEditing({ mode: 'add' })} disabled={!types.length}>
              Add a credential
            </button>
          ) : null}
        </div>

        <p className="gk-cred-note">
          Saved encrypted in the workspace folder. The key that unlocks them is kept in your profile folder instead, so a copy of the workspace carries
          nothing readable. If that key is ever lost, the credentials have to be entered again. Saved values are never shown back to you.
        </p>

        {error ? (
          <p className="gk-home-error" role="alert">
            {error}
          </p>
        ) : null}

        {editing ? (
          <CredentialForm
            types={types}
            editing={editing}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              setError(null);
              await load();
            }}
          />
        ) : null}

        {items === null ? (
          <p className="gk-home-muted">Loading…</p>
        ) : items.length === 0 ? (
          <div className="gk-home-empty">
            <h2>No credentials yet</h2>
            <p>Add a token or key here, then pick it in an HTTP or measuring box’s settings.</p>
          </div>
        ) : (
          <ul className="gk-home-list" aria-label="Saved credentials">
            {items.map((c) => (
              <li key={c.id} className="gk-home-row gk-cred-row">
                <span className="gk-cred-name">
                  <strong>{c.name}</strong>
                  <span className="gk-home-desc">{title(c.type)}</span>
                  {c.status === 'needs_reauth' ? (
                    <span className="gk-cred-warn">Needs signing in again{c.statusMessage ? `: ${c.statusMessage}` : ''}</span>
                  ) : null}
                </span>
                <span className="gk-home-meta">Updated {relative(c.updatedAt)}</span>
                <button type="button" className="gk-home-plain" onClick={() => setEditing({ mode: 'replace', credential: c })} aria-label={`Replace values of ${c.name}`}>
                  Replace values
                </button>
                {confirming === c.id ? (
                  <span className="gk-home-confirm">
                    Delete for good?
                    <button type="button" className="gk-home-danger" onClick={() => void remove(c.id)}>
                      Delete
                    </button>
                    <button type="button" className="gk-home-plain" onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <button type="button" className="gk-home-plain" onClick={() => setConfirming(c.id)} aria-label={`Delete ${c.name}`}>
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

function CredentialForm({
  types,
  editing,
  onCancel,
  onSaved,
}: {
  types: CredentialTypeManifest[];
  editing: Editing;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const replacing = editing.mode === 'replace' ? editing.credential : undefined;
  const [type, setType] = useState(replacing?.type ?? types[0]?.type ?? '');
  const [name, setName] = useState(replacing?.name ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manifest = types.find((t) => t.type === type);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (replacing) await api.replaceCredential(replacing.id, { name, values });
      else await api.createCredential({ type, name, values });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <form className="gk-cred-form" onSubmit={(e) => void submit(e)} aria-label={replacing ? `Replace ${replacing.name}` : 'Add a credential'}>
      <h2>{replacing ? `Replace “${replacing.name}”` : 'Add a credential'}</h2>
      {replacing ? <p className="gk-home-muted">Enter every value again: saved values are never shown, so none can be kept by leaving a field as it was.</p> : null}

      {!replacing ? (
        <div className="gk-cred-field">
          <label htmlFor="gk-cred-kind">Kind</label>
          <select id="gk-cred-kind" value={type} onChange={(e) => (setType(e.target.value), setValues({}))} aria-describedby="gk-cred-kind-hint">
            {types.map((t) => (
              <option key={t.type} value={t.type}>
                {t.title}
              </option>
            ))}
          </select>
          {manifest?.description ? <small id="gk-cred-kind-hint">{manifest.description}</small> : null}
        </div>
      ) : null}

      <div className="gk-cred-field">
        <label htmlFor="gk-cred-name">Name</label>
        <input id="gk-cred-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dev API" required maxLength={80} />
      </div>

      {manifest?.fields.map((f) => {
        const id = `gk-cred-${f.name}`;
        const hint = f.description ? `${id}-hint` : undefined;
        return (
          <div className="gk-cred-field" key={`${type}:${f.name}`}>
            <label htmlFor={id}>
              {f.label ?? f.name}
              {f.required ? <span className="gk-required" aria-hidden="true">*</span> : null}
            </label>
            {f.type === 'select' ? (
              <select id={id} value={values[f.name] ?? f.default ?? ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} aria-describedby={hint}>
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                type={f.secret ? 'password' : 'text'}
                autoComplete={f.secret ? 'new-password' : 'off'}
                spellCheck={false}
                value={values[f.name] ?? ''}
                placeholder={f.default ?? ''}
                aria-required={f.required || undefined}
                aria-describedby={hint}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
              />
            )}
            {hint ? <small id={hint}>{f.description}</small> : null}
          </div>
        );
      })}

      {error ? (
        <p className="gk-home-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="gk-cred-actions">
        <button type="submit" className="gk-app-primary" disabled={saving}>
          {saving ? 'Saving…' : replacing ? 'Save new values' : 'Save credential'}
        </button>
        <button type="button" className="gk-home-plain" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
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
