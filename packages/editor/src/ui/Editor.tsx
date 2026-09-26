import '@xyflow/react/dist/style.css';
import './editor.css';

import { useEffect, useMemo, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';

import type { NodeManifest, WorkflowDocument } from '@goblin/spec';

import { createEditorStore, type EditorBackend } from '../store.js';
import { AddPanel } from './AddPanel.js';
import { Canvas } from './Canvas.js';
import { RunsPanel } from './RunsPanel.js';
import { SettingsPanel } from './SettingsPanel.js';
import { TopBar } from './TopBar.js';
import { EditorContext, useEditor, useEditorStore } from './context.js';
import { Icon } from './icons.js';
import { lowerFirst } from './text.js';

export interface EditorProps {
  doc: WorkflowDocument;
  manifests: NodeManifest[];
  backend: EditorBackend;
  logoUrl: string;
  onBack: () => void;
}

/** The whole canvas screen: rail, top bar, canvas, and the floating panel. */
export function Editor(props: EditorProps) {
  // One store per open workflow. Keyed on the id, so opening another
  // workflow starts clean instead of inheriting undo history.
  const store = useMemo(
    () => createEditorStore({ doc: props.doc, manifests: props.manifests, backend: props.backend }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.doc.id],
  );

  useEffect(() => {
    void store.getState().refreshHistory();
    void store.getState().refreshActivation();
    // While switched on, runs start without anyone pressing Run: keep the
    // history and each schedule's next time current. Cheap, local calls.
    const poll = setInterval(() => {
      if (!store.getState().activation?.active) return;
      void store.getState().refreshActivation();
      void store.getState().refreshHistory();
    }, 10_000);
    // Save whatever is pending when leaving the screen or closing the tab.
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (store.getState().save.state !== 'saved') {
        void store.getState().flushSave();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      clearInterval(poll);
      window.removeEventListener('beforeunload', beforeUnload);
      void store.getState().flushSave();
    };
  }, [store]);

  return (
    <EditorContext.Provider value={store}>
      <ReactFlowProvider>
        <Shortcuts />
        <div className="gk-editor">
          <Rail logoUrl={props.logoUrl} onBack={props.onBack} />
          <div className="gk-main">
            <TopBar onBack={props.onBack} />
            <ActiveBanner />
            <PastRunBanner />
            <div className="gk-canvas">
              <Canvas />
              <FloatingPanel />
              <EmptyHint />
              <Toaster />
            </div>
          </div>
        </div>
      </ReactFlowProvider>
    </EditorContext.Provider>
  );
}

function Rail({ logoUrl, onBack }: { logoUrl: string; onBack: () => void }) {
  const store = useEditorStore();
  const panel = useEditor((s) => s.panel?.kind);
  return (
    <nav className="gk-rail" aria-label="Main">
      <img className="gk-rail-logo" src={logoUrl} alt="GoblinKit" />
      <button type="button" className="gk-rail-btn" onClick={onBack} title="All workflows" aria-label="All workflows">
        <Icon name="grid" size={19} />
      </button>
      <button
        type="button"
        className={`gk-rail-btn${panel === 'add' ? ' is-active' : ''}`}
        onClick={() => store.getState().openPanel(panel === 'add' ? null : { kind: 'add' })}
        title="Add a box"
        aria-label="Add a box"
      >
        <Icon name="plus" size={19} />
      </button>
      <button
        type="button"
        className={`gk-rail-btn${panel === 'runs' ? ' is-active' : ''}`}
        onClick={() => store.getState().openPanel(panel === 'runs' ? null : { kind: 'runs' })}
        title="Runs"
        aria-label="Runs"
      >
        <Icon name="clock" size={19} />
      </button>
      <button type="button" className="gk-rail-btn" onClick={() => store.getState().tidy()} title="Tidy up the layout" aria-label="Tidy up the layout">
        <Icon name="layout" size={19} />
      </button>
    </nav>
  );
}

function FloatingPanel() {
  const panel = useEditor((s) => s.panel);
  if (!panel) return null;
  switch (panel.kind) {
    case 'add':
      return <AddPanel {...(panel.from ? { from: panel.from } : {})} {...(panel.at ? { at: panel.at } : {})} />;
    case 'box':
      return <SettingsPanel nodeId={panel.nodeId} tab={panel.tab} />;
    case 'runs':
      return <RunsPanel />;
  }
}

/**
 * While switched on: what will start this workflow, and the one limit that
 * matters in local mode — it only happens while GoblinKit is open.
 */
function ActiveBanner() {
  const activation = useEditor((s) => s.activation);
  if (!activation?.active) return null;
  const parts = activation.triggers.map((t) =>
    t.kind === 'schedule'
      ? `${t.label}: ${lowerFirst(t.description)}${t.nextRunAt ? `, next at ${time(t.nextRunAt)}` : ''}`
      : `${t.label}: listening for ${lowerFirst(t.description)}`,
  );
  const failing = activation.triggers.find((t) => t.lastError);
  return (
    <div className="gk-banner gk-banner-active" role="status">
      <span className="gk-live-dot" aria-hidden="true" />
      <span>
        <strong>Active.</strong> {parts.join(' · ')}. Starts by itself only while GoblinKit is open.
        {failing ? <span className="gk-banner-warn"> {failing.lastError}</span> : null}
      </span>
    </div>
  );
}

function time(ms: number): string {
  const d = new Date(ms);
  const today = d.toDateString() === new Date().toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function PastRunBanner() {
  const store = useEditorStore();
  const historical = useEditor((s) => s.run.historical);
  const record = useEditor((s) => s.run.record);
  if (!historical || !record) return null;
  return (
    <div className="gk-banner">
      Showing a past run from {new Date(record.startedAt).toLocaleString()} ({record.status}). Boxes show what happened then.
      <button type="button" className="gk-link-btn" onClick={() => store.getState().closeRunView()}>
        Back to editing
      </button>
    </div>
  );
}

function EmptyHint() {
  const store = useEditorStore();
  const count = useEditor((s) => s.doc.nodes.length);
  const panel = useEditor((s) => s.panel);
  if (count > 1 || panel) return null;
  return (
    <div className="gk-hint">
      <strong>Start by adding a box.</strong> Use the + under a box to add the next step, or
      <button type="button" className="gk-link-btn" onClick={() => store.getState().openPanel({ kind: 'add' })}>
        open the box list
      </button>
      and drag one onto the canvas. Then drag from a dot at the bottom of a box to a dot at the top of another to connect them.
    </div>
  );
}

function Toaster() {
  const toast = useEditor((s) => s.toast);
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (!toast) return;
    setShown(toast.id);
    const t = setTimeout(() => setShown(null), toast.tone === 'error' ? 5000 : 2800);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || shown !== toast.id) return null;
  return (
    <div className={`gk-toast gk-toast-${toast.tone}`} role="status">
      {toast.text}
    </div>
  );
}

/**
 * Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl+Y, Ctrl/Cmd+S; R and Shift+R turn the
 * selected boxes. All ignored while typing in a field.
 */
function Shortcuts() {
  const store = useEditorStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]');
      const key = e.key.toLowerCase();
      if (!mod) {
        if (key === 'r' && !typing && !e.altKey && store.getState().selection.nodes.length) {
          e.preventDefault();
          store.getState().rotate(e.shiftKey ? -90 : 90);
        }
        return;
      }
      if (key === 's') {
        e.preventDefault();
        void store.getState().flushSave();
        return;
      }
      if (typing) return;
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        store.getState().undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        store.getState().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);
  return null;
}
