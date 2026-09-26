/**
 * The editor's state: the document, and everything the canvas shows around it.
 *
 * The document store owns the truth (§15.2); React Flow only renders a
 * projection of it. Every edit arrives as a DocumentCommand through
 * `dispatch`, which is also where undo history, validation and autosave hang.
 * The live run lives in its own slice so a streaming run never re-renders the
 * document (§15.3, rule 5).
 */

import { createStore, type StoreApi } from 'zustand/vanilla';

import { compile } from '@goblin/graph';
import {
  MapRegistry,
  validateDocument,
  type Diagnostic,
  type NodeInstance,
  type NodeManifest,
  type WorkflowDocument,
  type XY,
} from '@goblin/spec';
import type { ActivationStatus, LogLine, RunDetail, RunRecord, RunStreamMessage, TriggerStatus } from '@goblin/api/protocol';

import { applyCommand, newEdgeId, newNodeId, type DocumentCommand } from './document/commands.js';
import { History } from './document/history.js';
import { whyNotConnect, type Wire } from './document/connect.js';
import { idleProjection, projectEntries, type RunProjection } from './run/projection.js';
import { BOX_HEIGHT, BOX_WIDTH, tidyLayout } from './layout.js';
import { flowDirection, rotationOf } from './rotation.js';

/** What the editor needs from the outside world. The web app implements it over HTTP. */
export interface EditorBackend {
  save(doc: WorkflowDocument): Promise<WorkflowDocument>;
  /** Rejects with RunRefused when the workflow has problems. */
  startRun(doc: WorkflowDocument): Promise<RunRecord>;
  follow(runId: string, onMessage: (message: RunStreamMessage) => void): () => void;
  listRuns(workflowId: string): Promise<RunRecord[]>;
  getRun(runId: string): Promise<RunDetail>;
  getActivation(workflowId: string): Promise<ActivationStatus>;
  /** Rejects with the reason when switching on is refused. */
  setActive(workflowId: string, active: boolean): Promise<ActivationStatus>;
}

export class RunRefused extends Error {
  constructor(message: string, readonly diagnostics: Diagnostic[]) {
    super(message);
  }
}

export type Panel =
  | null
  /** `from`: grow from a box's output. `at`: drop where the canvas was right-clicked. */
  | { kind: 'add'; from?: { node: string; port: string }; at?: XY }
  | { kind: 'box'; nodeId: string; tab: 'settings' | 'input' | 'output' }
  | { kind: 'runs' };

export interface RunSlice {
  projection: RunProjection;
  runId?: string;
  record?: RunRecord;
  logs: LogLine[];
  starting: boolean;
  /** True while showing a past run rather than the latest one started here. */
  historical: boolean;
}

export interface Toast {
  id: number;
  tone: 'info' | 'error' | 'success';
  text: string;
}

export interface EditorState {
  doc: WorkflowDocument;
  manifests: NodeManifest[];
  registry: MapRegistry;
  diagnostics: Diagnostic[];
  /** Problems per box and per wire, for marking them on the canvas. */
  problems: { nodes: Record<string, Diagnostic[]>; edges: Record<string, Diagnostic[]>; general: Diagnostic[] };
  selection: { nodes: string[]; edges: string[] };
  panel: Panel;
  save: { state: 'saved' | 'saving' | 'unsaved' | 'error'; message?: string };
  canUndo: boolean;
  canRedo: boolean;
  run: RunSlice;
  history: RunRecord[];
  toast?: Toast;
  /** Whether the workflow starts by itself, and its Schedule / Webhook boxes' state. From the server. */
  activation?: ActivationStatus;
  /** Per box id, for the boxes that start the workflow by themselves. */
  triggers: Readonly<Record<string, TriggerStatus>>;
  switching: boolean;

  /** Nodes by id, so a box finds itself without scanning the list (§15.3, rule 2). */
  byId: Readonly<Record<string, NodeInstance>>;
  dispatch(cmd: DocumentCommand, coalesceKey?: string): void;
  undo(): void;
  redo(): void;
  select(selection: { nodes: string[]; edges: string[] }): void;
  openPanel(panel: Panel): void;
  connect(wire: Wire): boolean;
  addBox(type: string, options?: { at?: XY; from?: { node: string; port: string } }): string | undefined;
  removeSelected(): void;
  /** Turn boxes a quarter; with no ids, the selected ones. */
  rotate(by: 90 | -90, nodeIds?: string[]): void;
  tidy(): void;
  runNow(): Promise<void>;
  viewRun(runId: string): Promise<void>;
  closeRunView(): void;
  refreshHistory(): Promise<void>;
  flushSave(): Promise<void>;
  notify(tone: Toast['tone'], text: string): void;
  refreshActivation(): Promise<void>;
  setActive(active: boolean): Promise<void>;
}

export type EditorStore = StoreApi<EditorState>;

export function createEditorStore(args: {
  doc: WorkflowDocument;
  manifests: NodeManifest[];
  backend: EditorBackend;
}): EditorStore {
  const registry = new MapRegistry(args.manifests);
  const history = new History();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> | undefined;
  let stopFollowing: (() => void) | undefined;
  let toastSeq = 0;

  return createStore<EditorState>((set, get) => {
    /** Replace the document and everything derived from it. */
    const commit = (doc: WorkflowDocument) => {
      const diagnostics = diagnose(doc, registry);
      set({
        doc,
        byId: indexNodes(doc),
        diagnostics,
        problems: locate(doc, diagnostics),
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        save: { state: 'unsaved' },
      });
      scheduleSave();
    };

    const scheduleSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void get().flushSave(), 700);
    };

    const follow = (runId: string) => {
      stopFollowing?.();
      // Which box closes which loop, fixed for the length of the run.
      const scopeEnds = compile(get().doc, registry).scopeEnds;
      stopFollowing = args.backend.follow(runId, (message) => {
        const { run, doc } = get();
        if (run.runId !== runId) return;
        if (message.type === 'entries') {
          set({ run: { ...run, projection: projectEntries(run.projection, message.entries, doc, scopeEnds) } });
        } else if (message.type === 'log') {
          set({ run: { ...run, logs: [...run.logs, message.line] } });
        } else {
          set({ run: { ...run, record: message.record } });
          stopFollowing = undefined;
          void get().refreshHistory();
          if (!run.historical) {
            const s = message.record.status;
            get().notify(
              s === 'succeeded' ? 'success' : s === 'failed' ? 'error' : 'info',
              s === 'succeeded' ? 'Run finished.' : s === 'failed' ? `Run failed: ${message.record.error ?? 'a box failed'}` : `Run ${s}.`,
            );
          }
        }
      });
    };

    const initialDiagnostics = diagnose(args.doc, registry);

    return {
      doc: args.doc,
      byId: indexNodes(args.doc),
      manifests: args.manifests,
      registry,
      diagnostics: initialDiagnostics,
      problems: locate(args.doc, initialDiagnostics),
      selection: { nodes: [], edges: [] },
      panel: null,
      save: { state: 'saved' },
      canUndo: false,
      canRedo: false,
      run: { projection: idleProjection, logs: [], starting: false, historical: false },
      history: [],
      triggers: {},
      switching: false,

      dispatch(cmd, coalesceKey) {
        const before = get().doc;
        const after = applyCommand(before, cmd);
        history.record(before, after, coalesceKey);
        commit(after);
      },

      undo() {
        const doc = history.undo();
        if (doc) commit(doc);
      },

      redo() {
        const doc = history.redo();
        if (doc) commit(doc);
      },

      select(selection) {
        const prev = get().selection;
        if (same(prev.nodes, selection.nodes) && same(prev.edges, selection.edges)) return;
        set({ selection });
      },

      openPanel(panel) {
        set({ panel });
      },

      connect(wire) {
        const reason = whyNotConnect(get().doc, registry, wire);
        if (reason) {
          get().notify('error', reason);
          return false;
        }
        const doc = get().doc;
        get().dispatch({
          kind: 'Connect',
          edge: { id: newEdgeId(doc), from: { node: wire.source, port: wire.sourcePort }, to: { node: wire.target, port: wire.targetPort } },
        });
        return true;
      },

      addBox(type, options = {}) {
        const manifest = args.manifests.find((m) => m.type === type);
        if (!manifest) return undefined;
        const doc = get().doc;
        const id = newNodeId(doc, manifest.title);

        const config: NodeInstance['config'] = {};
        for (const field of manifest.config?.fields ?? []) {
          if (field.default !== undefined) config[field.name] = field.default;
        }

        const from = options.from ? doc.nodes.find((n) => n.id === options.from!.node) : undefined;
        const rotation = from ? rotationOf(from) : 0;
        let at: XY;
        if (from) {
          // One step on from the box it grows from, in the direction its
          // output faces; a sibling already there pushes it sideways.
          const base = from.ui?.position ?? { x: 0, y: 0 };
          const d = flowDirection(rotation);
          at = freeSpot(
            doc,
            { x: base.x + d.x * (BOX_WIDTH + 90), y: base.y + d.y * (BOX_HEIGHT + 90) },
            d.y !== 0 ? { x: BOX_WIDTH + 40, y: 0 } : { x: 0, y: BOX_HEIGHT + 40 },
          );
        } else {
          // Where it was dropped or asked for; if that is on top of a box, below it.
          at = freeSpot(doc, options.at ?? { x: 0, y: 0 }, { x: 0, y: BOX_HEIGHT + 40 });
        }

        const node: NodeInstance = {
          id,
          type: manifest.type,
          typeVersion: manifest.version,
          label: manifest.title,
          config,
          // A box grown from a turned box faces the same way, so the flow keeps its direction.
          ui: rotation ? { position: at, rotation } : { position: at },
        };

        const edges =
          options.from && manifest.ports.inputs[0] && !manifest.trigger
            ? [{ id: newEdgeId(doc), from: options.from, to: { node: id, port: manifest.ports.inputs[0].id } }]
            : [];
        get().dispatch({ kind: 'AddNode', node, edges });
        set({ selection: { nodes: [id], edges: [] }, panel: { kind: 'box', nodeId: id, tab: 'settings' } });
        return id;
      },

      removeSelected() {
        const { selection, panel } = get();
        if (!selection.nodes.length && !selection.edges.length) return;
        get().dispatch({ kind: 'RemoveElements', nodeIds: selection.nodes, edgeIds: selection.edges });
        set({
          selection: { nodes: [], edges: [] },
          panel: panel?.kind === 'box' && selection.nodes.includes(panel.nodeId) ? null : panel,
        });
      },

      rotate(by, nodeIds) {
        const ids = nodeIds ?? get().selection.nodes;
        if (ids.length) get().dispatch({ kind: 'RotateNodes', nodeIds: ids, by });
      },

      tidy() {
        get().dispatch({ kind: 'MoveNodes', moves: tidyLayout(get().doc) });
      },

      async runNow() {
        await get().flushSave();
        set({ run: { ...get().run, starting: true } });
        try {
          const record = await args.backend.startRun(get().doc);
          set({
            run: { projection: idleProjection, runId: record.runId, record, logs: [], starting: false, historical: false },
          });
          follow(record.runId);
          void get().refreshHistory();
        } catch (error) {
          set({ run: { ...get().run, starting: false } });
          get().notify('error', error instanceof Error ? error.message : String(error));
        }
      },

      async viewRun(runId) {
        stopFollowing?.();
        set({ run: { projection: idleProjection, runId, logs: [], starting: false, historical: true } });
        // follow() replays a finished run from storage, or joins a live one.
        follow(runId);
      },

      closeRunView() {
        stopFollowing?.();
        stopFollowing = undefined;
        set({ run: { projection: idleProjection, logs: [], starting: false, historical: false } });
      },

      async refreshHistory() {
        try {
          set({ history: await args.backend.listRuns(get().doc.id) });
        } catch {
          // History is a convenience; the canvas keeps working without it.
        }
      },

      async flushSave() {
        clearTimeout(saveTimer);
        if (saving) await saving;
        if (get().save.state === 'saved') return;
        const doc = get().doc;
        set({ save: { state: 'saving' } });
        saving = args.backend
          .save(doc)
          .then(() => {
            // Only "saved" if nothing changed while the request was out.
            if (get().doc === doc) set({ save: { state: 'saved' } });
            else set({ save: { state: 'unsaved' } });
            // A new Webhook box gets its URL, a changed schedule its next time.
            void get().refreshActivation();
          })
          .catch((error: unknown) => {
            set({ save: { state: 'error', message: error instanceof Error ? error.message : String(error) } });
          })
          .finally(() => {
            saving = undefined;
          });
        await saving;
        if (get().save.state === 'unsaved') scheduleSave();
      },

      notify(tone, text) {
        set({ toast: { id: ++toastSeq, tone, text } });
      },

      async refreshActivation() {
        try {
          const activation = await args.backend.getActivation(get().doc.id);
          set({ activation, triggers: Object.fromEntries(activation.triggers.map((t) => [t.nodeId, t])) });
        } catch {
          // Status is a convenience; editing carries on without it.
        }
      },

      async setActive(active) {
        // Switch on what is on screen, not the last autosave.
        await get().flushSave();
        set({ switching: true });
        try {
          const activation = await args.backend.setActive(get().doc.id, active);
          set({ activation, triggers: Object.fromEntries(activation.triggers.map((t) => [t.nodeId, t])) });
          get().notify(
            'success',
            active ? 'Active: this workflow now starts by itself while GoblinKit is open.' : 'Switched off. It runs only when you press Run.',
          );
        } catch (error) {
          get().notify('error', error instanceof Error ? error.message : String(error));
        } finally {
          set({ switching: false });
        }
      },
    };
  });
}

function diagnose(doc: WorkflowDocument, registry: MapRegistry): Diagnostic[] {
  return [...validateDocument(doc, registry), ...compile(doc, registry).diagnostics];
}

/** Attach each diagnostic to the box or wire its path points at. */
function locate(doc: WorkflowDocument, diagnostics: Diagnostic[]): EditorState['problems'] {
  const nodes: Record<string, Diagnostic[]> = {};
  const edges: Record<string, Diagnostic[]> = {};
  const general: Diagnostic[] = [];
  for (const d of diagnostics) {
    const [where, index] = d.path;
    const id =
      typeof index === 'number' ? (where === 'nodes' ? doc.nodes[index]?.id : where === 'edges' ? doc.edges[index]?.id : undefined) : undefined;
    if (id && where === 'nodes') (nodes[id] ??= []).push(d);
    else if (id && where === 'edges') (edges[id] ??= []).push(d);
    else general.push(d);
  }
  return { nodes, edges, general };
}

/**
 * The first position from `at`, stepping by `step`, that does not sit on an
 * existing box. A new box landing on top of another hides both, and the
 * person then has to find it and drag it out before they can wire it.
 */
export function freeSpot(doc: WorkflowDocument, at: XY, step: XY): XY {
  const clash = (p: XY) =>
    doc.nodes.some((n) => {
      const q = n.ui?.position;
      return q !== undefined && Math.abs(q.x - p.x) < BOX_WIDTH + 24 && Math.abs(q.y - p.y) < BOX_HEIGHT + 24;
    });
  let p = at;
  for (let i = 0; i < 50 && clash(p); i++) p = { x: p.x + step.x, y: p.y + step.y };
  return p;
}

/** Unchanged boxes keep their object, so a box re-renders only when it changed. */
function indexNodes(doc: WorkflowDocument): Record<string, NodeInstance> {
  return Object.fromEntries(doc.nodes.map((n) => [n.id, n]));
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
