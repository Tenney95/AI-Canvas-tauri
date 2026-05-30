/**
 * Canvas 画布主组件 — React Flow 画布核心，管理节点/边渲染、拖放、连线、右键菜单、空状态
 */
import { useCallback, useState, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  ConnectionMode,
  useReactFlow,
  useViewport,
  ReactFlowProvider,
  Panel,
  applyNodeChanges,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import TextNode from './nodes/TextNode';
import ImageNode from './nodes/ImageNode';
import VideoNode from './nodes/VideoNode';
import AudioNode from './nodes/AudioNode';
import ConnectionMenu from './canvas/ConnectionMenu';
import CanvasContextMenu from './canvas/CanvasContextMenu';
import NodeContextMenu from './canvas/NodeContextMenu';
import CanvasToolbar from './canvas/CanvasToolbar';
import CanvasEmptyState from './canvas/CanvasEmptyState';
import { useConnectionDropMenu } from '../hooks/useConnectionDropMenu';
import { useCanvasContextMenu } from '../hooks/useCanvasContextMenu';
import { useNodeContextMenu } from '../hooks/useNodeContextMenu';
import { useAppStore, generateId } from '../store/useAppStore';
import type { BaseNodeData } from '../types';
import type { Node as RFNode, NodeTypes } from '@xyflow/react';
import { useNodeSnap, type SnapLine } from '../hooks/useNodeSnap';

// ── Node types mapping ──
const nodeTypes: NodeTypes = {
  'ai-text': TextNode,
  'ai-image': ImageNode,
  'ai-video': VideoNode,
  'ai-audio': AudioNode,
};

// ── Snap lines overlay ──
function SnapLinesOverlay({ lines }: { lines: SnapLine[] }) {
  const { x, y, zoom } = useViewport();
  if (lines.length === 0) return null;
  return (
    <div
      className="pointer-events-none"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 999,
        transform: `translate(${x}px, ${y}px) scale(${zoom})`,
        transformOrigin: '0 0',
      }}
    >
      <svg
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 1,
          height: 1,
          overflow: 'visible',
        }}
      >
        {lines.map((line, i) =>
          line.type === 'horizontal' ? (
            <line
              key={`h-${i}`}
              x1={-99999}
              y1={line.position}
              x2={99999}
              y2={line.position}
              stroke="#6366f1"
              strokeWidth={1}
              strokeDasharray="4 4"
              opacity={0.7}
            />
          ) : (
            <line
              key={`v-${i}`}
              x1={line.position}
              y1={-99999}
              x2={line.position}
              y2={99999}
              stroke="#6366f1"
              strokeWidth={1}
              strokeDasharray="4 4"
              opacity={0.7}
            />
          )
        )}
      </svg>
    </div>
  );
}

function CanvasInner() {
  const {
    nodes,
    edges,
    onConnect,
    addNode,
    setNodes,
    setEdges,
    setSelectedNodeIds,
  } = useAppStore();
  const reactFlowInstance = useReactFlow();

  // ── UI toggles (persisted to localStorage) ──
  const [showGrid, setShowGrid] = useState(() => localStorage.getItem('canvas-showGrid') !== 'false');
  const [smoothLine, setSmoothLine] = useState(() => localStorage.getItem('canvas-smoothLine') !== 'false');

  useEffect(() => { localStorage.setItem('canvas-showGrid', String(showGrid)); }, [showGrid]);
  useEffect(() => { localStorage.setItem('canvas-smoothLine', String(smoothLine)); }, [smoothLine]);

  // Sync existing edges when line type changes
  useEffect(() => {
    setEdges(edges.map((e) => ({ ...e, type: smoothLine ? 'smoothstep' : 'default' })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smoothLine]);

  // ── Zoom ──
  const [zoomPercent, setZoomPercent] = useState(100);

  const handleMove = useCallback(
    (_evt: any, viewport: { zoom: number }) => {
      setZoomPercent(Math.round(viewport.zoom * 100));
    },
    [],
  );

  const toggleGrid = useCallback(() => setShowGrid((v) => !v), []);

  const handleZoomSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      reactFlowInstance.zoomTo(Number(e.target.value) / 100);
    },
    [reactFlowInstance],
  );

  // ── Connection drop menu ──
  const {
    menu: connectionMenu,
    menuRef: connectionMenuRef,
    handleConnectEnd,
    handleSelect: handleConnectionMenuSelect,
    connectionMenuMap,
    sourceNode,
  } = useConnectionDropMenu(smoothLine);

  // ── Node context menu ──
  const {
    menu: nodeCtxMenu,
    menuRef: nodeCtxMenuRef,
    openMenu: openNodeCtxMenu,
    handleCopy,
    handleCut,
    handleDuplicate,
    handleDelete,
  } = useNodeContextMenu();

  // ── Canvas context menu ──
  const {
    menu: ctxMenu,
    menuRef: ctxMenuRef,
    submenuRef: ctxSubmenuRef,
    openMenu: openCtxMenu,
    addNodeAtCtxPos,
    handleUndo: handleCtxUndo,
    handleRedo: handleCtxRedo,
    handlePaste: handleCtxPaste,
    showSubmenu,
    hideSubmenu,
  } = useCanvasContextMenu();

  // ── External clipboard paste (native paste event → DataTransfer) ──
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      // Skip if user is editing an input
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.contentEditable === 'true') return;
      // Skip if internal clipboard has nodes (handled by keyboard shortcut)
      if (useAppStore.getState().clipboard.length > 0) return;

      e.preventDefault();
      e.stopPropagation();

      const vp = reactFlowInstance.getViewport();
      const centerX = (window.innerWidth / 2 - vp.x) / vp.zoom;
      const centerY = (window.innerHeight / 2 - vp.y) / vp.zoom;
      useAppStore.getState().pasteExternalFromDataTransfer(e.clipboardData, { x: centerX, y: centerY });
    };
    window.addEventListener('paste', handler, true);
    return () => window.removeEventListener('paste', handler, true);
  }, [reactFlowInstance]);

  // ── Double-click: add text node ──
  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if ((event.target as HTMLElement).classList.contains('react-flow__pane')) {
        const position = reactFlowInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });
        addNode({
          id: `node-${generateId()}`,
          type: 'ai-text',
          position,
          data: {
            label: '生成文本',
            type: 'ai-text',
            prompt: '',
            status: 'idle',
            nodeWidth: 280,
            nodeHeight: 160,
          },
        });
      }
    },
    [reactFlowInstance, addNode],
  );

  // ── Node click → AI dialog ──
  const openNodeDialog = useAppStore((s) => s.openNodeDialog);
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: RFNode<BaseNodeData>) => {
      if (node.data?.role === 'source') return;
      if (node.data?.type === 'ai-text' && node.data?.output) return;
      if (node.data?.type === 'ai-image' && node.data?.imageUrl) return;
      if (node.data?.type === 'ai-video' && node.data?.videoUrl) return;

      const el = document.querySelector(`.react-flow__node[data-id="${node.id}"]`);
      if (el) {
        const rect = el.getBoundingClientRect();
        openNodeDialog(node.id, { x: rect.left + rect.width / 2, y: rect.bottom });
      } else {
        openNodeDialog(node.id);
      }
    },
    [openNodeDialog],
  );

  // ── Selection sync ──
  const onSelectionChange = useCallback(
    (changes: OnSelectionChangeParams) => {
      setSelectedNodeIds(changes.nodes.map((n) => n.id));
    },
    [setSelectedNodeIds],
  );

  // ── Node change handler ──
  const handleNodesChange = useCallback(
    (changes: any[]) => {
      const updated = applyNodeChanges(changes, nodes) as RFNode<BaseNodeData>[];
      const removedIds = changes
        .filter((c) => c.type === 'remove')
        .map((c: any) => c.id!);
      if (removedIds.length > 0) {
        useAppStore.getState().commitToHistory();
        useAppStore.setState((s) => ({
          nodes: updated,
          edges: s.edges.filter(
            (e) => !removedIds.includes(e.source) && !removedIds.includes(e.target),
          ),
        }));
      } else {
        setNodes(updated);
      }
    },
    [nodes, setNodes],
  );

  // ── Node snap ──
  const { snapLines, onNodeDragStart, onNodeDrag, onNodeDragStop } =
    useNodeSnap(nodes, setNodes);

  return (
    <div className="absolute inset-0 bg-canvas-bg">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onConnect={onConnect}
        onConnectEnd={handleConnectEnd}
        isValidConnection={(conn) => conn.source !== conn.target}
        onNodeClick={onNodeClick}
        onDoubleClick={onDoubleClick}
        onSelectionChange={onSelectionChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodesChange={handleNodesChange}
        nodeTypes={nodeTypes}
        connectionMode={ConnectionMode.Loose}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={5}
        defaultEdgeOptions={{
          type: smoothLine ? 'smoothstep' : 'default',
          style: { stroke: '#33334a', strokeWidth: 1.5 },
          animated: false,
        }}
        onMove={handleMove}
        proOptions={{ hideAttribution: true }}
        className="bg-canvas-bg"
        panOnDrag={[1, 2]}
        onContextMenu={openCtxMenu}
        onNodeContextMenu={openNodeCtxMenu}
      >
        {/* Snap alignment lines */}
        <SnapLinesOverlay lines={snapLines} />

        {/* Grid background */}
        {showGrid && (
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="#252535"
          />
        )}

        {/* Mini Map */}
        <MiniMap
          nodeColor={() => '#1a1a26'}
          maskColor="rgba(10, 10, 15, 0.7)"
          style={{
            backgroundColor: '#14141c',
            border: '1px solid #2a2a3a',
            borderRadius: '8px',
          }}
          className="!bottom-4 !right-4 !w-[180px] !h-[120px]"
        />

        {/* Canvas Controls */}
        <Controls
          className="!bg-canvas-card !border-canvas-border !shadow-lg !rounded-xl overflow-hidden"
          showInteractive={false}
        />

        {/* Toolbar */}
        <Panel position="bottom-right" className="flex items-center gap-2">
          <CanvasToolbar
            showGrid={showGrid}
            zoomPercent={zoomPercent}
            smoothLine={smoothLine}
            onToggleGrid={toggleGrid}
            onToggleLine={() => setSmoothLine((v) => !v)}
            onZoomChange={handleZoomSlider}
          />
        </Panel>

        {/* Empty state */}
        {nodes.length === 0 && <CanvasEmptyState />}
      </ReactFlow>

      {/* Connection drop menu */}
      <ConnectionMenu
        visible={connectionMenu.visible}
        position={connectionMenu.position}
        sourceNodeType={connectionMenu.sourceNodeType}
        sourceNode={sourceNode}
        menuRef={connectionMenuRef}
        onSelect={handleConnectionMenuSelect}
        connectionMenuMap={connectionMenuMap}
      />

      {/* Context menu */}
      <CanvasContextMenu
        visible={ctxMenu.visible}
        position={ctxMenu.position}
        hoverMenu={ctxMenu.hoverMenu}
        menuRef={ctxMenuRef}
        submenuRef={ctxSubmenuRef}
        onAddNode={addNodeAtCtxPos}
        onUndo={handleCtxUndo}
        onRedo={handleCtxRedo}
        onPaste={handleCtxPaste}
        onShowSubmenu={showSubmenu}
        onHideSubmenu={hideSubmenu}
      />

      {/* Node context menu */}
      <NodeContextMenu
        visible={nodeCtxMenu.visible}
        position={nodeCtxMenu.position}
        menuRef={nodeCtxMenuRef}
        onCopy={handleCopy}
        onCut={handleCut}
        onDuplicate={handleDuplicate}
        onDelete={handleDelete}
      />
    </div>
  );
}

export default function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
