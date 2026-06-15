/**
 * Canvas 画布主组件 — React Flow 画布核心，管理节点/边渲染、拖放、连线、右键菜单、空状态
 */
import { useCallback, useState, useEffect, useMemo } from 'react';
import { ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  ConnectionMode,
  SelectionMode,
  useReactFlow,
  useViewport,
  ReactFlowProvider,
  Panel,
  applyNodeChanges,
  applyEdgeChanges,
  type OnSelectionChangeParams,
  type NodeChange,
  type EdgeChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import TextNode from './nodes/TextNode';
import ImageNode from './nodes/ImageNode';
import VideoNode from './nodes/VideoNode';
import AudioNode from './nodes/AudioNode';
import PanoramaNode from './nodes/PanoramaNode';
import MarkdownNode from './nodes/MarkdownNode';
import GroupNode from './nodes/GroupNode';
import ConnectionMenu from './canvas/ConnectionMenu';
import CanvasContextMenu from './canvas/CanvasContextMenu';
import NodeContextMenu from './canvas/NodeContextMenu';
import CanvasToolbar from './canvas/CanvasToolbar';
import MultiSelectToolbar from './canvas/MultiSelectToolbar';
import CanvasEmptyState from './canvas/CanvasEmptyState';
import { useConnectionDropMenu } from '../hooks/useConnectionDropMenu';
import { useCanvasContextMenu } from '../hooks/useCanvasContextMenu';
import { useNodeContextMenu } from '../hooks/useNodeContextMenu';
import { useAppStore } from '../store/useAppStore';
import { useNodeCreation } from '../hooks/useNodeCreation';
import type { BaseNodeData } from '../types';
import type { Node as RFNode, NodeTypes, Connection, Edge } from '@xyflow/react';
import { useNodeSnap, type SnapLine } from '../hooks/useNodeSnap';

// ── Node types mapping ──
const nodeTypes: NodeTypes = {
  'ai-text': TextNode,
  'ai-image': ImageNode,
  'ai-video': VideoNode,
  'ai-audio': AudioNode,
  'ai-panorama': PanoramaNode,
  'ai-markdown': MarkdownNode,
  group: GroupNode,
};

// ── Stable ReactFlow props (hoisted to avoid new identities every render,
//    which makes React Flow re-run internal effects and drop frames on drag) ──
const FIT_VIEW_OPTIONS = { padding: 0.2 };
const PRO_OPTIONS = { hideAttribution: true };
const PAN_ON_DRAG = [1, 2];
const DEFAULT_EDGE_STYLE = { stroke: '#33334a', strokeWidth: 1.5 };
const MINIMAP_STYLE = {
  width: 180,
  height: 120,
  border: '1px solid var(--theme-border)',
  borderRadius: '8px',
};
const isValidConnection = (conn: Connection | Edge) => conn.source !== conn.target;
const minimapNodeColor = (node: RFNode) => {
  switch (node.type) {
    case 'ai-text': return 'color-mix(in srgb, var(--node-text-light) 50%, transparent)';
    case 'ai-image': return 'color-mix(in srgb, var(--node-image-light) 50%, transparent)';
    case 'ai-video': return 'color-mix(in srgb, var(--node-video-light) 50%, transparent)';
    case 'ai-audio': return 'color-mix(in srgb, var(--node-audio-light) 50%, transparent)';
    case 'ai-panorama': return 'color-mix(in srgb, var(--node-panorama) 50%, transparent)';
    case 'ai-markdown': return 'color-mix(in srgb, var(--node-markdown-light) 50%, transparent)';
    case 'group': return '#4b556380';
    default: return '#6b728080';
  }
};

/** 分组节点 data 中可访问的字段 */
interface GroupNodeDataAccess {
  groupId: string;
}

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
              stroke="var(--brand)"
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
              stroke="var(--brand)"
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
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const onConnect = useAppStore((s) => s.onConnect);
  const setEdges = useAppStore((s) => s.setEdges);
  const setSelectedNodeIds = useAppStore((s) => s.setSelectedNodeIds);
  const minimapVisible = useAppStore((s) => s.minimapVisible);
  const reactFlowInstance = useReactFlow();
  const {
    isDragOver,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onDoubleClick,
  } = useNodeCreation();

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
    (_event: MouseEvent | TouchEvent | null, { zoom }: Viewport) => {
      setZoomPercent(Math.round(zoom * 100));
    },
    [],
  );

  // Track mouse position on canvas for node creation at cursor (on left-button release)
  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const flowPos = reactFlowInstance.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      useAppStore.setState({ lastCanvasMousePos: flowPos });
    },
    [reactFlowInstance],
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
    handleUngroup,
    handleDelete,
    handleShowInFolder,
    showInFolder,
  } = useNodeContextMenu();
  const isGroupNode = nodeCtxMenu.nodeId
    ? nodes.find((n) => n.id === nodeCtxMenu.nodeId && n.type === 'group') != null
    : false;

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
      if (useAppStore.getState().clipboard.nodes.length > 0) return;

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

  // ── Fit view event (project switch / F key) ──
  useEffect(() => {
    const handler = () => {
      // Wait one frame for React to finish rendering new nodes/edges
      requestAnimationFrame(() => {
        reactFlowInstance.fitView({ padding: 0.2 });
      });
    };
    window.addEventListener('canvas-fit-view', handler);
    return () => window.removeEventListener('canvas-fit-view', handler);
  }, [reactFlowInstance]);

  // ── Focus node event (history panel "查看节点") ──
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ nodeId: string }>).detail;
      if (!detail?.nodeId || !reactFlowInstance) return;
      const node = useAppStore.getState().nodes.find((n) => n.id === detail.nodeId);
      if (!node) return;
      requestAnimationFrame(() => {
        reactFlowInstance.setCenter(node.position.x, node.position.y, { zoom: 1, duration: 400 });
      });
    };
    window.addEventListener('canvas-focus-node', handler);
    return () => window.removeEventListener('canvas-focus-node', handler);
  }, [reactFlowInstance]);

  // ── Node click → AI dialog ──
  const openNodeDialog = useAppStore((s) => s.openNodeDialog);
  const onNodeClick = useCallback(
    (e: React.MouseEvent, node: RFNode<BaseNodeData>) => {
      // Shift+click is for multi-select, don't open dialog
      if (e.shiftKey) return;
      // Group / Markdown / source nodes have no AI dialog
      if (node.type === 'group') return;
      if (node.data?.type === 'ai-markdown') return;
      if (node.data?.role === 'source') return;
      if (node.data?.type === 'ai-text' && node.data?.output) return;
      if (node.data?.type === 'ai-image' && node.data?.imageUrl) return;
      if (node.data?.type === 'ai-panorama' && node.data?.imageUrl) return;
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

  // ── Edge change handler — apply selection / removal changes
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      useAppStore.setState((s) => ({
        edges: applyEdgeChanges(changes, s.edges) as typeof s.edges,
      }));
    },
    [],
  );

  // ── Node snap ──
  const { snapLines, onNodeDragStart, applySnap, onNodeDragStop } =
    useNodeSnap(nodes);

  // 仅在线型切换时重建，避免每帧新对象触发 React Flow 内部更新
  const defaultEdgeOptions = useMemo(
    () => ({
      type: smoothLine ? 'smoothstep' : 'default',
      style: DEFAULT_EDGE_STYLE,
      animated: false,
    }),
    [smoothLine],
  );

  // ── Node change handler ──
  const handleNodesChange = useCallback(
    (changes: NodeChange<RFNode<BaseNodeData>>[]) => {
      // 单节点拖拽时，把吸附后的位置直接注入 React Flow 的变更管线
      // （成为唯一真相源，避免二次 setNodes 覆盖导致的漂移/橡皮筋）。
      // 注意：松手那一帧 dragging=false 也要吸附，否则会弹回原始落点（位移）。
      // applySnap 在非拖拽期（dragCtx 为空）是无副作用直通，故无需判断 dragging。
      // 多选拖拽不吸附，以保持选中节点之间的相对位置。
      const draggingPosChanges = changes.filter(
        (c) => c.type === 'position' && c.position,
      );
      let snapped = changes;
      if (draggingPosChanges.length === 1) {
        const dc = draggingPosChanges[0];
        if (dc.type === 'position' && dc.position) {
          const snappedPos = applySnap(dc.id, dc.position);
          snapped = changes.map((c) => (c === dc ? { ...c, position: snappedPos } : c));
        }
      }

      // Detect group node removals — convert to ungroup
      const removedIds = snapped
        .filter((c) => c.type === 'remove')
        .map((c) => c.id);

      // 快速路径：纯拖拽/选择变更（无删除）—— 用函数式更新，始终基于最新
      // store.nodes，避免快速拖动时闭包 nodes 过期导致的抖动卡顿。
      if (removedIds.length === 0) {
        useAppStore.setState((s) => ({
          nodes: applyNodeChanges(snapped, s.nodes) as RFNode<BaseNodeData>[],
        }));
        return;
      }

      const removedGroupNodes = useAppStore.getState().nodes.filter(
        (n) => removedIds.includes(n.id) && n.type === 'group',
      );

      if (removedGroupNodes.length > 0) {
        useAppStore.getState().commitToHistory();
        const groupNodeIdSet = new Set(removedGroupNodes.map((n) => n.id));
        const store = useAppStore.getState();
        const removedGroupDataIds = removedGroupNodes.map(
          (n) => (n.data as unknown as GroupNodeDataAccess).groupId,
        );

        // Reposition children to absolute coordinates
        const groupPositions = new Map(
          removedGroupNodes.map((gn) => [gn.id, gn.position]),
        );

        const repositioned = store.nodes
          .map((n) => {
            if (!n.parentId || !groupPositions.has(n.parentId)) return n;
            const gp = groupPositions.get(n.parentId)!;
            return {
              ...n,
              position: { x: n.position.x + gp.x, y: n.position.y + gp.y },
              parentId: undefined,
            };
          })
          .filter((n) => !groupNodeIdSet.has(n.id));

        // Apply remaining non-group-removal changes
        const finalNodes = applyNodeChanges(
          snapped.filter(
            (c) => c.type !== 'remove' || !groupNodeIdSet.has(c.id),
          ),
          repositioned,
        ) as RFNode<BaseNodeData>[];

        useAppStore.setState((s) => ({
          nodes: finalNodes,
          edges: s.edges.filter(
            (e) =>
              !removedIds.includes(e.source) && !removedIds.includes(e.target),
          ),
          groups: s.groups.filter((g) => !removedGroupDataIds.includes(g.id)),
        }));
        return;
      }

      // 含删除：提交历史并基于最新状态应用
      useAppStore.getState().commitToHistory();
      useAppStore.setState((s) => ({
        nodes: applyNodeChanges(snapped, s.nodes) as RFNode<BaseNodeData>[],
        edges: s.edges.filter(
          (e) => !removedIds.includes(e.source) && !removedIds.includes(e.target),
        ),
      }));
    },
    [applySnap],
  );

  // ── Auto group/ungroup on drag stop ──
  const handleNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: RFNode) => {
      const store = useAppStore.getState();
      const allNodes = store.nodes;

      // Skip group nodes themselves
      if (node.type === 'group') {
        onNodeDragStop();
        return;
      }

      // Compute absolute position (follow parent chain)
      const absPos = { x: node.position.x, y: node.position.y };
      let pid = node.parentId;
      while (pid) {
        const p = allNodes.find((n) => n.id === pid);
        if (!p) break;
        absPos.x += p.position.x;
        absPos.y += p.position.y;
        pid = p.parentId;
      }

      const nodeWidth =
        (node.data?.nodeWidth as number) || node.measured?.width || 280;
      const nodeHeight =
        (node.data?.nodeHeight as number) || node.measured?.height || 160;
      const nodeCenter = {
        x: absPos.x + nodeWidth / 2,
        y: absPos.y + nodeHeight / 2,
      };

      const groupNodes = allNodes.filter((n) => n.type === 'group');
      let newNodes = allNodes.map((n) => ({ ...n, position: { ...n.position } }));
      let newGroups = [...store.groups];
      let changed = false;

      // 1) Check if node should leave its current parent group
      if (node.parentId) {
        const parentNode = groupNodes.find((g) => g.id === node.parentId);
        if (parentNode) {
          const pw = (parentNode.style?.width as number) || 400;
          const ph = (parentNode.style?.height as number) || 300;
          const inside =
            nodeCenter.x >= parentNode.position.x &&
            nodeCenter.x <= parentNode.position.x + pw &&
            nodeCenter.y >= parentNode.position.y &&
            nodeCenter.y <= parentNode.position.y + ph;
          if (!inside) {
            newNodes = newNodes.map((n) => {
              if (n.id !== node.id) return n;
              return { ...n, position: absPos, parentId: undefined };
            });
            const gdata = parentNode.data as unknown as GroupNodeDataAccess;
            const gId = gdata?.groupId;
            newGroups = newGroups.map((g) =>
              g.id === gId
                ? { ...g, nodeIds: g.nodeIds.filter((id) => id !== node.id) }
                : g,
            );
            changed = true;
          }
        }
      }

      // 2) Check if free node should enter a group
      const updatedNode = newNodes.find((n) => n.id === node.id)!;
      if (!updatedNode.parentId) {
        for (const gn of groupNodes) {
          const pw = (gn.style?.width as number) || 400;
          const ph = (gn.style?.height as number) || 300;
          if (
            nodeCenter.x >= gn.position.x &&
            nodeCenter.x <= gn.position.x + pw &&
            nodeCenter.y >= gn.position.y &&
            nodeCenter.y <= gn.position.y + ph
          ) {
            newNodes = newNodes.map((n) => {
              if (n.id !== node.id) return n;
              return {
                ...n,
                position: {
                  x: absPos.x - gn.position.x,
                  y: absPos.y - gn.position.y,
                },
                parentId: gn.id,
              };
            });
            const gdata = gn.data as unknown as GroupNodeDataAccess;
            const gId = gdata?.groupId;
            newGroups = newGroups.map((g) =>
              g.id === gId
                ? { ...g, nodeIds: [...new Set([...g.nodeIds, node.id])] }
                : g,
            );
            changed = true;
            break; // join first overlapping group only
          }
        }
      }

      // 3) Auto-delete groups that have become empty
      if (changed) {
        const emptyGroupIds = new Set(
          groupNodes
            .filter(
              (gn) =>
                newNodes.filter((n) => n.parentId === gn.id).length === 0,
            )
            .map((gn) => gn.id),
        );
        if (emptyGroupIds.size > 0) {
          newNodes = newNodes.filter((n) => !emptyGroupIds.has(n.id));
          const emptyDataIds = new Set(
            groupNodes
              .filter((gn) => emptyGroupIds.has(gn.id))
              .map((gn) => (gn.data as unknown as GroupNodeDataAccess).groupId)
              .filter(Boolean),
          );
          newGroups = newGroups.filter((g) => !emptyDataIds.has(g.id));
        }

        store.commitToHistory(); // capture pre-change state
        useAppStore.setState({ nodes: newNodes, groups: newGroups });
      }

      // Always call snap handler last (it commits final state for undo)
      onNodeDragStop();
    },
    [onNodeDragStop],
  );

  return (
    <div className="absolute inset-0">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onConnect={onConnect}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isValidConnection}
        onNodeClick={onNodeClick}
        onDoubleClick={onDoubleClick}
        onSelectionChange={onSelectionChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        nodeTypes={nodeTypes}
        connectionMode={ConnectionMode.Loose}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.1}
        maxZoom={5}
        defaultEdgeOptions={defaultEdgeOptions}
        onMove={handleMove}
        proOptions={PRO_OPTIONS}
        panOnDrag={PAN_ON_DRAG}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode="Shift"
        onContextMenu={openCtxMenu}
        onNodeContextMenu={openNodeCtxMenu}
        onMouseUp={handleMouseUp}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* Snap alignment lines */}
        <SnapLinesOverlay lines={snapLines} />

        {/* Grid background */}
        {showGrid && (
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="var(--theme-hover)"
          />
        )}


        {/* Mini Map — interactive navigator, toggle with M key */}
        {minimapVisible && (
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
          nodeColor={minimapNodeColor}
          nodeStrokeColor="var(--theme-border)"
          nodeStrokeWidth={1.5}
          nodeBorderRadius={35}
          bgColor="var(--theme-surface)"
          maskColor="rgba(10, 10, 15, 0.75)"
          maskStrokeColor="var(--brand)"
          maskStrokeWidth={1}
          style={MINIMAP_STYLE}
          className="!bottom-12 !right-1"
        />
        )}

        {/* Canvas Controls */}
        <Controls
          className="canvas-controls !bg-canvas-card !border-canvas-border !shadow-lg !rounded-xl overflow-hidden"
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

        {/* Drop zone overlay */}
        {isDragOver && (
          <Panel position="top-left" className="!m-0 !inset-0 pointer-events-none z-50">
            <div className="absolute inset-0 border-2 border-dashed border-indigo-400/60 rounded-2xl m-3 flex items-center justify-center">
              <div className="rounded-2xl px-8 py-5 text-center pointer-events-none"
                style={{
                  backgroundColor: 'rgba(99, 102, 241, 0.08)',
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                }}>
                <div className="text-4xl mb-2">📂</div>
                <div className="text-base font-medium text-indigo-300">拖放文件到此处</div>
                <div className="text-xs text-indigo-400/60 mt-1">支持文本 · 图片 · 视频 · 音频</div>
              </div>
            </div>
          </Panel>
        )}
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
        onUngroup={isGroupNode ? handleUngroup : undefined}
        onDelete={handleDelete}
        onShowInFolder={showInFolder ? handleShowInFolder : undefined}
      />

      {/* Multi-select toolbar */}
      <MultiSelectToolbar />
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
