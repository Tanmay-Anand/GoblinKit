import type { JsonValue } from '@goblin/spec';

import { Icon } from './icons.js';
import { JsonField } from './SettingsPanel.js';
import { useEditor, useEditorStore } from './context.js';

/**
 * The workflow's variables: values every box can read as `{{ $vars.name }}`
 * — the address of the API under test, a page size. Kept in the document, so
 * never a secret; those belong in a credential.
 */
export function VariablesPanel() {
  const store = useEditorStore();
  const variables = useEditor((s) => s.doc.variables);
  const names = Object.keys(variables ?? {});

  return (
    <aside className="gk-panel gk-settings" aria-label="Variables">
      <header className="gk-panel-head">
        <div>
          <h2>Variables</h2>
          <p className="gk-panel-sub">Read in any box as {'{{ $vars.name }}'}.</p>
        </div>
        <button type="button" className="gk-icon-btn" onClick={() => store.getState().openPanel(null)} aria-label="Close">
          <Icon name="x" />
        </button>
      </header>
      <div className="gk-panel-scroll">
        <div className="gk-field">
          <label className="gk-field-label" htmlFor="gk-variables">
            Values
          </label>
          <JsonField
            id="gk-variables"
            required={false}
            value={variables ?? {}}
            onChange={(v) => {
              if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) return;
              store.getState().dispatch({ kind: 'SetVariables', variables: v as Record<string, JsonValue> | undefined }, 'variables');
            }}
          />
          <span className="gk-field-hint">An object of name → value, like {'{ "baseUrl": "http://localhost:8080" }'}. Never put a token here: use a credential.</span>
        </div>
        {names.length ? (
          <ul className="gk-var-list" aria-label="In expressions">
            {names.map((n) => (
              <li key={n}>
                <code>{`{{ $vars.${n} }}`}</code>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </aside>
  );
}
