/**
 * @goblin/editor — the canvas, reusable on top of the kit.
 *
 * A second product built on GoblinKit keeps this and swaps the node packs and
 * the app shell around it. It knows boxes only through their manifests, and
 * the outside world only through EditorBackend.
 */

export { Editor, type EditorProps } from './ui/Editor.js';
export { StatusPill } from './ui/RunsPanel.js';
export { Icon } from './ui/icons.js';
export { createEditorStore, RunRefused, type EditorBackend, type EditorState, type EditorStore } from './store.js';
export { applyCommand, type DocumentCommand } from './document/commands.js';
export { tidyLayout } from './layout.js';
