import { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';

import { CATEGORIES, COMING, describeType, portLabel } from '../describe.js';
import { BOX_WIDTH } from '../layout.js';
import { BOX_DRAG_TYPE } from './Canvas.js';
import { Icon } from './icons.js';
import { useEditor, useEditorStore } from './context.js';

const ORDER = ['start', 'logic', 'data', 'loops', 'actions', 'timing', 'other'];

/**
 * The palette: every box the app knows, built from manifests alone (§15.1).
 * Click to add, or drag onto the canvas. Opened from a box's "+", it adds the
 * new box underneath and wires it up in the same step.
 */
export function AddPanel({ from }: { from?: { node: string; port: string } }) {
  const store = useEditorStore();
  const manifests = useEditor((s) => s.manifests);
  const source = useEditor((s) => (from ? s.byId[from.node] : undefined));
  const [query, setQuery] = useState('');
  const flow = useReactFlow();

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byGroup = new Map<string, typeof manifests>();
    for (const m of manifests) {
      // Growing the flow from a box can't add a trigger: nothing feeds into one.
      if (from && m.trigger) continue;
      if (q && !`${m.title} ${m.description ?? ''}`.toLowerCase().includes(q)) continue;
      const cat = describeType(m).category.id;
      byGroup.set(cat, [...(byGroup.get(cat) ?? []), m]);
    }
    return ORDER.filter((id) => byGroup.has(id)).map((id) => ({ category: CATEGORIES[id]!, items: byGroup.get(id)! }));
  }, [manifests, query, from]);

  const coming = COMING.filter((c) => !query.trim() || c.title.toLowerCase().includes(query.trim().toLowerCase()));

  const add = (type: string) => {
    if (from) {
      store.getState().addBox(type, { from });
      return;
    }
    // Drop it in the middle of what's on screen, not at the origin off-screen.
    const pane = document.querySelector('.gk-canvas')?.getBoundingClientRect();
    const centre = pane
      ? flow.screenToFlowPosition({ x: pane.left + pane.width / 2 - 170, y: pane.top + pane.height / 2 })
      : { x: 0, y: 0 };
    store.getState().addBox(type, { at: { x: Math.round(centre.x - BOX_WIDTH / 2), y: Math.round(centre.y - 40) } });
  };

  return (
    <aside className="gk-panel gk-add" aria-label="Add a box">
      <header className="gk-panel-head">
        <div>
          <h2>Add a box</h2>
          {source ? (
            <p className="gk-panel-sub">
              After <strong>{source.label ?? source.id}</strong>
              {from && portLabel(source.type, from.port) ? ` · ${portLabel(source.type, from.port)}` : ''}
            </p>
          ) : (
            <p className="gk-panel-sub">Click one, or drag it onto the canvas.</p>
          )}
        </div>
        <button type="button" className="gk-icon-btn" onClick={() => store.getState().openPanel(null)} aria-label="Close">
          <Icon name="x" />
        </button>
      </header>

      <label className="gk-search">
        <Icon name="search" size={15} />
        <input
          id="gk-add-search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search boxes"
          aria-label="Search boxes"
        />
      </label>

      <div className="gk-panel-scroll">
        {groups.map(({ category, items }) => (
          <section key={category.id} className="gk-add-group">
            <h3>{category.title}</h3>
            {items.map((m) => {
              const look = describeType(m);
              return (
                <button
                  key={`${m.type}@${m.version}`}
                  type="button"
                  className="gk-add-item"
                  draggable={!from}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(BOX_DRAG_TYPE, m.type);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => add(m.type)}
                >
                  <span className="gk-tile" style={{ color: look.category.hue, background: look.category.tint }}>
                    <Icon name={look.glyph} size={15} />
                  </span>
                  <span className="gk-add-text">
                    <span className="gk-add-title">{m.title}</span>
                    {m.description ? <span className="gk-add-desc">{m.description}</span> : null}
                  </span>
                </button>
              );
            })}
          </section>
        ))}
        {groups.length === 0 && coming.length === 0 ? <p className="gk-empty">No box matches “{query}”.</p> : null}

        {coming.length > 0 ? (
          <section className="gk-add-group is-coming">
            <h3>Coming later</h3>
            {coming.map((c) => {
              const cat = CATEGORIES[c.category]!;
              return (
                <div key={c.title} className="gk-add-item is-disabled" aria-disabled="true">
                  <span className="gk-tile" style={{ color: cat.hue, background: cat.tint }}>
                    <Icon name={c.glyph} size={15} />
                  </span>
                  <span className="gk-add-text">
                    <span className="gk-add-title">{c.title}</span>
                    <span className="gk-add-desc">{c.blurb}</span>
                  </span>
                  <span className="gk-stage-tag">Stage {c.stage}</span>
                </div>
              );
            })}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
