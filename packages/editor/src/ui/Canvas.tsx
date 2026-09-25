import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type OnNodeDrag,
} from '@xyflow/react';

import { whyNotConnect } from '../document/connect.js';
import { describeType } from '../describe.js';
import { BOX_WIDTH } from '../layout.js';
import { BoxNode, type BoxFlowNode } from './BoxNode.js';
import { PortEdge, type PortFlowEdge } from './PortEdge.js';
import { useEditor, useEditorStore } from './context.js';

// Declared once, outside any component (§15.3, rule 1): a new object here on
// each render makes React Flow remount every box.
const nodeTypes = { box: BoxNode };
const edgeTypes = { port: PortEdge };
const NO_DATA = {} as Record<string, never>;

export const BOX_DRAG_TYPE = 'application/x-goblin-box';

export function Canvas() {
  const store = useEditorStore();
  const docNodes = useEditor((s) => s.doc.nodes);
  const docEdges = useEditor((s) => s.doc.edges);
  const selection = useEditor((s) => s.selection);
  const registry = useEditor((s) => s.registry);
  const flow = useReactFlow();

  // React Flow measures boxes and keeps that on its node objects, so the
  // canvas holds its own copy and re-syncs it from the document, carrying the
  // measurements over. The document stays the truth; this is a render cache.
  const [nodes, setNodes] = useState<BoxFlowNode[]>([]);
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return docNodes.map((n) => ({
        ...old.get(n.id),
        id: n.id,
        type: 'box' as const,
        position: n.ui?.position ?? { x: 0, y: 0 },
        data: NO_DATA,
        selected: selection.nodes.includes(n.id),
        width: BOX_WIDTH,
        // The box's name is its accessible name: screen readers announce it,
        // and tests find a box the way a person would, by what it is called.
        ariaLabel: n.label ?? n.id,
      }));
    });
  }, [docNodes, selection.nodes]);

  const edges = useMemo<PortFlowEdge[]>(() => {
    const name = new Map(docNodes.map((n) => [n.id, n.label ?? n.id]));
    return docEdges.map((e) => ({
      id: e.id,
      type: 'port' as const,
      source: e.from.node,
      sourceHandle: e.from.port,
      target: e.to.node,
      targetHandle: e.to.port,
      selected: selection.edges.includes(e.id),
      data: NO_DATA,
      ariaLabel: `Wire from ${name.get(e.from.node) ?? e.from.node} to ${name.get(e.to.node) ?? e.to.node}`,
    }));
  }, [docEdges, docNodes, selection.edges]);

  const onNodesChange = useCallback(
    (changes: NodeChange<BoxFlowNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
      const picks = changes.filter((c) => c.type === 'select');
      if (picks.length) {
        const chosen = new Set(store.getState().selection.nodes);
        for (const c of picks) (c.selected ? chosen.add(c.id) : chosen.delete(c.id));
        store.getState().select({ nodes: [...chosen], edges: store.getState().selection.edges });
      }
    },
    [store],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<PortFlowEdge>[]) => {
      const picks = changes.filter((c) => c.type === 'select');
      if (!picks.length) return;
      const chosen = new Set(store.getState().selection.edges);
      for (const c of picks) (c.selected ? chosen.add(c.id) : chosen.delete(c.id));
      store.getState().select({ nodes: store.getState().selection.nodes, edges: [...chosen] });
    },
    [store],
  );

  // One undo step per drag, however many frames it took.
  const onNodeDragStop = useCallback<OnNodeDrag<BoxFlowNode>>(
    (_event, _node, dragged) => {
      const byId = store.getState().byId;
      const moves = dragged
        .filter((n) => {
          const was = byId[n.id]?.ui?.position;
          return !was || was.x !== n.position.x || was.y !== n.position.y;
        })
        .map((n) => ({ id: n.id, to: { x: Math.round(n.position.x), y: Math.round(n.position.y) } }));
      if (moves.length) store.getState().dispatch({ kind: 'MoveNodes', moves });
    },
    [store],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      store.getState().connect({
        source: c.source,
        sourcePort: c.sourceHandle ?? 'main',
        target: c.target,
        targetPort: c.targetHandle ?? 'main',
      });
    },
    [store],
  );

  // Refuse a bad wire while it is still being dragged. The sentence saying why
  // comes from connect() if the person lets go anyway.
  const isValidConnection = useCallback<IsValidConnection<PortFlowEdge>>(
    (c) =>
      whyNotConnect(store.getState().doc, registry, {
        source: c.source,
        sourcePort: c.sourceHandle ?? 'main',
        target: c.target,
        targetPort: c.targetHandle ?? 'main',
      }) === null,
    [store, registry],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      const type = event.dataTransfer.getData(BOX_DRAG_TYPE);
      if (!type) return;
      event.preventDefault();
      const p = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      store.getState().addBox(type, { at: { x: Math.round(p.x - BOX_WIDTH / 2), y: Math.round(p.y - 24) } });
    },
    [flow, store],
  );

  const minimapColour = useCallback(
    (n: BoxFlowNode) => {
      const node = store.getState().byId[n.id];
      const manifest = node ? registry.get(node.type, node.typeVersion) : undefined;
      return manifest ? describeType(manifest).category.hue : '#9aa1a9';
    },
    [store, registry],
  );

  return (
    <ReactFlow<BoxFlowNode, PortFlowEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onDelete={({ nodes: gone, edges: cut }) =>
        store.getState().dispatch({ kind: 'RemoveElements', nodeIds: gone.map((n) => n.id), edgeIds: cut.map((e) => e.id) })
      }
      onNodeClick={(_e, n) => store.getState().openPanel({ kind: 'box', nodeId: n.id, tab: 'settings' })}
      onPaneClick={() => {
        const panel = store.getState().panel;
        if (panel?.kind === 'box') store.getState().openPanel(null);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(BOX_DRAG_TYPE)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={onDrop}
      deleteKeyCode={['Delete', 'Backspace']}
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
      minZoom={0.2}
      maxZoom={1.75}
      snapToGrid
      snapGrid={[8, 8]}
      // React Flow asks that its attribution stay unless you subscribe to Pro;
      // bottom-left keeps it clear of the minimap and zoom controls.
      attributionPosition="bottom-left"
      defaultEdgeOptions={{ type: 'port' }}
      connectionLineStyle={{ stroke: '#1f8fd6', strokeWidth: 2 }}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1.4} color="#c9ced4" />
      <MiniMap
        position="bottom-right"
        pannable
        zoomable
        nodeColor={minimapColour}
        nodeBorderRadius={3}
        maskColor="rgba(243, 244, 246, 0.7)"
        className="gk-minimap"
        ariaLabel="Overview of the whole workflow"
      />
      <Controls position="bottom-right" showInteractive={false} className="gk-controls" />
    </ReactFlow>
  );
}
