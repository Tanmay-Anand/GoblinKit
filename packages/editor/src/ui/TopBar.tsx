import { Icon } from './icons.js';
import { useEditor, useEditorStore } from './context.js';

/**
 * The workflow's name, where its changes stand, and the actions: tidy, undo,
 * redo, the run history, and Run. Laid out like the reference's header —
 * name and badge on the left, a text action, an outlined dropdown, and one
 * solid primary button on the right.
 */
export function TopBar({ onBack }: { onBack: () => void }) {
  const store = useEditorStore();
  const name = useEditor((s) => s.doc.name);
  const save = useEditor((s) => s.save);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const panel = useEditor((s) => s.panel?.kind);
  const errors = useEditor((s) => s.diagnostics.filter((d) => d.severity === 'error').length);
  const status = useEditor((s) => s.run.projection.status);
  const starting = useEditor((s) => s.run.starting);
  const historical = useEditor((s) => s.run.historical);
  const active = useEditor((s) => s.activation?.active === true);
  const switching = useEditor((s) => s.switching);
  const busy = starting || status === 'running' || status === 'waiting';

  const showProblem = () => {
    const { problems, doc } = store.getState();
    const first = doc.nodes.find((n) => problems.nodes[n.id]?.some((d) => d.severity === 'error'));
    if (first) {
      store.getState().select({ nodes: [first.id], edges: [] });
      store.getState().openPanel({ kind: 'box', nodeId: first.id, tab: 'settings' });
    } else {
      const general = problems.general[0] ?? Object.values(problems.edges)[0]?.[0];
      if (general) store.getState().notify('error', general.message);
    }
  };

  return (
    <header className="gk-topbar">
      <button type="button" className="gk-icon-btn" onClick={onBack} aria-label="Back to all workflows" title="All workflows">
        <Icon name="back" size={18} />
      </button>
      <input
        id="gk-workflow-name"
        className="gk-name-input"
        value={name}
        onChange={(e) => store.getState().dispatch({ kind: 'RenameWorkflow', name: e.target.value }, 'workflow:name')}
        onBlur={(e) => {
          if (!e.target.value.trim()) store.getState().dispatch({ kind: 'RenameWorkflow', name: 'Untitled workflow' });
        }}
        aria-label="Workflow name"
        size={Math.max(8, name.length + 1)}
      />
      <span className={`gk-badge${active ? ' is-active' : ''}`}>{active ? 'Active' : 'Draft'}</span>
      <span className={`gk-save gk-save-${save.state}`} title={save.message} aria-live="polite">
        {save.state === 'saved' ? 'Saved' : save.state === 'saving' ? 'Saving…' : save.state === 'unsaved' ? 'Unsaved changes' : 'Could not save'}
      </span>

      <div className="gk-topbar-actions">
        {errors > 0 ? (
          <button type="button" className="gk-problem-pill" onClick={showProblem} title="Show the first problem">
            <Icon name="alert" size={14} /> {errors} problem{errors === 1 ? '' : 's'}
          </button>
        ) : null}
        <button type="button" className="gk-link-btn" onClick={() => store.getState().tidy()}>
          Tidy up
        </button>
        <span className="gk-divider" />
        <button type="button" className="gk-icon-btn" disabled={!canUndo} onClick={() => store.getState().undo()} aria-label="Undo" title="Undo (Ctrl+Z)">
          <Icon name="undo" />
        </button>
        <button type="button" className="gk-icon-btn" disabled={!canRedo} onClick={() => store.getState().redo()} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
          <Icon name="redo" />
        </button>
        <button
          type="button"
          className={`gk-btn-outline${panel === 'runs' ? ' is-pressed' : ''}`}
          onClick={() => store.getState().openPanel(panel === 'runs' ? null : { kind: 'runs' })}
          aria-expanded={panel === 'runs'}
        >
          {historical ? 'Past run' : 'Runs'} <Icon name={panel === 'runs' ? 'chevronUp' : 'chevronDown'} size={14} />
        </button>
        <button
          type="button"
          className={`gk-btn-outline ${active ? 'gk-btn-stop' : 'gk-btn-accent'}`}
          disabled={switching}
          aria-pressed={active}
          title={active ? 'Stop starting by itself' : 'Let its Schedule and Webhook boxes start it by themselves'}
          onClick={() => void store.getState().setActive(!active)}
        >
          {active ? 'Deactivate' : 'Activate'}
        </button>
        <button
          type="button"
          className="gk-btn-primary"
          disabled={busy}
          onClick={() => {
            if (errors > 0) {
              showProblem();
              store.getState().notify('error', `Fix ${errors === 1 ? 'the problem' : `the ${errors} problems`} marked in red first.`);
              return;
            }
            void store.getState().runNow();
          }}
        >
          {busy ? <Icon name="spinner" size={14} className="gk-spin" /> : <Icon name="play" size={12} />}
          {busy ? 'Running' : 'Run'}
        </button>
      </div>
    </header>
  );
}
