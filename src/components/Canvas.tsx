import { useCallback, useState, useEffect, useRef } from 'react';
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
import { useAppStore, generateId } from '../store/useAppStore';
import type { NodeType, BaseNodeData } from '../types';
import type { Node as RFNode, NodeTypes, Edge } from '@xyflow/react';
import type { FinalConnectionState } from '@xyflow/react';
import { useNodeSnap, type SnapLine } from '../hooks/useNodeSnap';

// ── 连线拖拽未命中 Handle 时弹出的"引用该节点生成"菜单 ──
interface ConnectionMenuOption {
  label: string;
  type: NodeType;
  /** 仅用于样式；不传则使用默认 ICON */
  special?: '360-panorama';
}

// ── Canvas right-click context menu ──
interface ContextMenuState {
  visible: boolean;
  position: { x: number; y: number };
  /** 右键点击时对应的画布坐标 */
  flowPosition: { x: number; y: number };
  /** 当前悬停展开的子菜单层级 */
  hoverMenu: 'addNode' | 'genNode' | 'srcNode' | null;
}

// 生成节点子菜单项
const GEN_NODE_ITEMS: { label: string; type: NodeType }[] = [
  { label: '生成文本', type: 'ai-text' },
  { label: '生成图像', type: 'ai-image' },
  { label: '生成视频', type: 'ai-video' },
  { label: '生成音频', type: 'ai-audio' },
];

// 源节点子菜单项
const SRC_NODE_ITEMS: { label: string; type: NodeType }[] = [
  { label: '文本', type: 'ai-text' },
  { label: '图像', type: 'ai-image' },
  { label: '视频', type: 'ai-video' },
  { label: '音频', type: 'ai-audio' },
];

const CONNECTION_MENU_MAP: Record<string, ConnectionMenuOption[]> = {
  'ai-text': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
    { label: '生成音频', type: 'ai-audio' },
  ],
  'ai-image': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
    { label: '生成360全景图', type: 'ai-image', special: '360-panorama' },
  ],
  'ai-video': [],
  'ai-audio': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成音频', type: 'ai-audio' },
  ],
};

interface ConnectionMenuState {
  visible: boolean;
  sourceNodeId: string;
  sourceNodeType: string;
  sourceHandleId: string | null;
  position: { x: number; y: number }; // screen coords
}

// Node types mapping for React Flow
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
    addNodeWithEdge,
    setNodes,
    setEdges,
    setSelectedNodeIds,
  } = useAppStore();
  const reactFlowInstance = useReactFlow();

  // Background grid visibility
  const [showGrid, setShowGrid] = useState(true);
  // Connection line type: true = smoothstep (直角), false = default (曲线)
  const [smoothLine, setSmoothLine] = useState(true);
  // Sync existing edges when line type changes
  useEffect(() => {
    setEdges(edges.map((e) => ({ ...e, type: smoothLine ? 'smoothstep' : 'default' })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smoothLine]);
  // Current zoom percentage (synced from ReactFlow viewport)
  const [zoomPercent, setZoomPercent] = useState(100);

  // ── Connection drop menu ──
  const [connectionMenu, setConnectionMenu] = useState<ConnectionMenuState>({
    visible: false,
    sourceNodeId: '',
    sourceNodeType: '',
    sourceHandleId: null,
    position: { x: 0, y: 0 },
  });
  const connectionMenuRef = useRef<HTMLDivElement>(null);

  // ── Right-click context menu ──
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>({
    visible: false,
    position: { x: 0, y: 0 },
    flowPosition: { x: 0, y: 0 },
    hoverMenu: null,
  });
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const ctxSubmenuRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeCtxMenu = useCallback(() => {
    setCtxMenu({ visible: false, position: { x: 0, y: 0 }, flowPosition: { x: 0, y: 0 }, hoverMenu: null });
  }, []);

  // Close context menu on click outside or Escape
  useEffect(() => {
    if (!ctxMenu.visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeCtxMenu();
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element;
      const ctxEl = ctxMenuRef.current;
      const subEl = ctxSubmenuRef.current;
      if ((ctxEl && ctxEl.contains(target)) || (subEl && subEl.contains(target))) return;
      // Also check if the target is inside any v2-canvas-ctx-menu (Level 3 submenus)
      if (target.closest('.v2-canvas-ctx-menu')) return;
      closeCtxMenu();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [ctxMenu.visible, closeCtxMenu]);

  // Close connection menu on click outside or Escape
  useEffect(() => {
    if (!connectionMenu.visible) return;
    const close = () => setConnectionMenu((s) => ({ ...s, visible: false }));
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onClick = (e: MouseEvent) => {
      if (connectionMenuRef.current && !connectionMenuRef.current.contains(e.target as Element)) {
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [connectionMenu.visible]);

  // Sync zoom from ReactFlow viewport changes
  const handleMove = useCallback(
    (_evt: any, viewport: { zoom: number }) => {
      setZoomPercent(Math.round(viewport.zoom * 100));
    },
    []
  );

  // Toggle background grid
  const toggleGrid = useCallback(() => setShowGrid((v) => !v), []);

  // Slider-driven zoom
  const handleZoomSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = Number(e.target.value);
      const zoom = val / 100;
      reactFlowInstance.zoomTo(zoom);
    },
    [reactFlowInstance]
  );

  // Handle double-click to add a text node by default
  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      // Only add when clicking on canvas background (not on nodes)
      if ((event.target as HTMLElement).classList.contains('react-flow__pane')) {
        const position = reactFlowInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });
        const newNode: RFNode<BaseNodeData> = {
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
        };
        addNode(newNode);
      }
    },
    [reactFlowInstance, addNode]
  );

  // ── Connection end handler (fires when user releases a connection drag) ──
  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      // Only show menu if connection was NOT completed (didn't land on a handle)
      if (connectionState.isValid === true) return;
      if (!connectionState.fromNode) return;

      const fromNode = connectionState.fromNode as RFNode;
      const sourceType = fromNode.type;
      if (!sourceType || !CONNECTION_MENU_MAP[sourceType]?.length) return;

      const mouseEvt = event as MouseEvent;
      setConnectionMenu({
        visible: true,
        sourceNodeId: fromNode.id,
        sourceNodeType: sourceType,
        sourceHandleId: connectionState.fromHandle?.id ?? null,
        position: { x: mouseEvt.clientX, y: mouseEvt.clientY },
      });
    },
    [],
  );

  // ── Handle connection menu item click: create new node + edge ──
  const handleConnectionMenuSelect = useCallback(
    (option: ConnectionMenuOption) => {
      const { sourceNodeId, position } = connectionMenu;
      // Convert screen coords to canvas coords
      const flowPos = reactFlowInstance.screenToFlowPosition({ x: position.x, y: position.y });

      // Get source node geometry
      const sourceNode = reactFlowInstance.getNode(sourceNodeId) as RFNode<BaseNodeData> | undefined;
      const srcX = sourceNode?.position?.x ?? 0;
      const srcY = sourceNode?.position?.y ?? 0;
      const srcWidth = (sourceNode?.data?.nodeWidth as number | undefined) ?? 280;
      const srcHeight = (sourceNode?.data?.nodeHeight as number | undefined) ?? 160;
      const srcRight = srcX + srcWidth;

      const newWidth = option.type === 'ai-audio' ? 260 : 280;
      const newHeight = option.type === 'ai-audio' ? 140 : option.type === 'ai-image' ? 158 : 160;
      const gap = 50;

      // Determine direction from RELEASE position (reliable) vs source node geometry
      // Only care about left/right; ignore vertical (up/down) handles
      const releasedRight = flowPos.x >= srcRight + 10;
      const releasedLeft = flowPos.x <= srcX - 10;

      let nodeX: number;
      let nodeY: number;
      let edgeSourceHandle: string | undefined;
      let edgeTargetHandle: string | undefined;

      if (releasedRight) {
        nodeX = srcRight + gap;
        nodeY = srcY + (srcHeight - newHeight) / 2;
        edgeSourceHandle = 'right';
        edgeTargetHandle = 'left';
      } else if (releasedLeft) {
        nodeX = srcX - newWidth - gap;
        nodeY = srcY + (srcHeight - newHeight) / 2;
        edgeSourceHandle = 'left';
        edgeTargetHandle = 'right';
      } else {
        // Mouse released within source node bounds → use handle fallback (left/right only)
        const handle = connectionMenu.sourceHandleId;
        if (handle === 'left') {
          nodeX = srcX - newWidth - gap;
          nodeY = srcY + (srcHeight - newHeight) / 2;
          edgeSourceHandle = 'left';
          edgeTargetHandle = 'right';
        } else {
          // Default to right
          nodeX = srcRight + gap;
          nodeY = srcY + (srcHeight - newHeight) / 2;
          edgeSourceHandle = 'right';
          edgeTargetHandle = 'left';
        }
      }

      const newNodeId = `node-${generateId()}`;
      const newNode: RFNode<BaseNodeData> = {
        id: newNodeId,
        type: option.type,
        position: { x: nodeX, y: nodeY },
        data: {
          label: option.label,
          type: option.type,
          prompt: '',
          status: 'idle',
          nodeWidth: newWidth,
          nodeHeight: newHeight,
          ...(option.type === 'ai-image' ? { aspectRatio: '16:9', imageSize: '2K' } : {}),
          ...(option.special === '360-panorama' ? { subType: '360-panorama' } : {}),
        },
      };
      const edge: Edge = {
        id: `edge-${generateId()}`,
        source: sourceNodeId,
        sourceHandle: edgeSourceHandle,
        target: newNodeId,
        targetHandle: edgeTargetHandle,
        type: smoothLine ? 'smoothstep' : 'default',
      };
      // Atomically add both node + edge in one state update
      addNodeWithEdge(newNode, edge);

      setConnectionMenu((s) => ({ ...s, visible: false }));
    },
    [connectionMenu, reactFlowInstance, addNode, addNodeWithEdge],
  );

  // ── Context menu actions ──
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const pasteNodes = useAppStore((s) => s.pasteNodes);
  const clipboard = useAppStore((s) => s.clipboard);

  // Add a single node at the right-click position
  const addNodeAtCtxPos = useCallback(
    (type: NodeType, label: string, role: 'generator' | 'source' = 'generator') => {
      const pos = ctxMenu.flowPosition;
      const flowPos = reactFlowInstance.screenToFlowPosition({ x: pos.x, y: pos.y });
      const isImage = type === 'ai-image';
      const isSource = role === 'source';
      const newWidth = type === 'ai-audio' ? 260 : 280;
      const newHeight = type === 'ai-audio' ? 140 : isImage ? 158 : 160;
      const newNode: RFNode<BaseNodeData> = {
        id: `node-${generateId()}`,
        type,
        position: { x: flowPos.x - newWidth / 2, y: flowPos.y - newHeight / 2 },
        data: {
          label,
          type,
          role,
          prompt: '',
          status: 'idle',
          nodeWidth: newWidth,
          nodeHeight: newHeight,
          ...(isImage && !isSource ? { aspectRatio: '16:9', imageSize: '2K' } : {}),
        },
      };
      addNode(newNode);
      closeCtxMenu();
    },
    [ctxMenu.flowPosition, reactFlowInstance, addNode, closeCtxMenu],
  );

  const handleCtxUndo = useCallback(() => {
    undo();
    closeCtxMenu();
  }, [undo, closeCtxMenu]);

  const handleCtxRedo = useCallback(() => {
    redo();
    closeCtxMenu();
  }, [redo, closeCtxMenu]);

  const handleCtxPaste = useCallback(() => {
    const pos = ctxMenu.flowPosition;
    const flowPos = reactFlowInstance.screenToFlowPosition({ x: pos.x, y: pos.y });
    pasteNodes(flowPos);
    closeCtxMenu();
  }, [ctxMenu.flowPosition, reactFlowInstance, pasteNodes, closeCtxMenu]);

  // Submenu hover: show immediately, hide with a delay (to allow cursor to cross gaps)
  const showSubmenu = useCallback((menu: ContextMenuState['hoverMenu']) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setCtxMenu((s) => ({ ...s, hoverMenu: menu }));
  }, []);

  const hideSubmenu = useCallback((backTo: ContextMenuState['hoverMenu']) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setCtxMenu((s) => ({ ...s, hoverMenu: backTo }));
    }, 250);
  }, []);

  // Handle node click to open AI dialog
  const openNodeDialog = useAppStore((s) => s.openNodeDialog);
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: RFNode<BaseNodeData>) => {
      // Source nodes have no AI dialog
      if (node.data?.role === 'source') return;
      // Text nodes with existing output don't need the prompt dialog
      if (node.data?.type === 'ai-text' && node.data?.output) return;

      const el = document.querySelector(`.react-flow__node[data-id="${node.id}"]`);
      if (el) {
        const rect = el.getBoundingClientRect();
        openNodeDialog(node.id, { x: rect.left + rect.width / 2, y: rect.bottom });
      } else {
        openNodeDialog(node.id);
      }
    },
    [openNodeDialog]
  );

  // Sync selected node IDs to store on selection change
  const onSelectionChange = useCallback(
    (changes: OnSelectionChangeParams) => {
      setSelectedNodeIds(changes.nodes.map((n) => n.id));
    },
    [setSelectedNodeIds]
  );

  // ── Node snap alignment lines ──
  const { snapLines, onNodeDragStart: handleNodeDragStart, onNodeDrag: handleNodeDrag, onNodeDragStop: handleNodeDragStop } =
    useNodeSnap(nodes, setNodes);

  return (
    <div className="absolute inset-0 bg-canvas-bg overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onConnect={onConnect}
        onConnectEnd={handleConnectEnd}
        isValidConnection={(conn) => conn.source !== conn.target}
        onNodeClick={onNodeClick}
        onDoubleClick={onDoubleClick}
        onSelectionChange={onSelectionChange}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onNodesChange={(changes) => {
          // Sync position/dimension/remove changes back to store
          const updated = applyNodeChanges(changes, nodes) as RFNode<BaseNodeData>[];
          // Clean up edges for removed nodes in the same batch
          const removedIds = changes
            .filter((c) => c.type === 'remove')
            .map((c) => c.id!);
          if (removedIds.length > 0) {
            useAppStore.setState((s) => ({
              nodes: updated,
              edges: s.edges.filter(
                (e) => !removedIds.includes(e.source) && !removedIds.includes(e.target)
              ),
            }));
          } else {
            setNodes(updated);
          }
        }}
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
        onContextMenu={(e: React.MouseEvent) => {
          e.preventDefault();
          // Only show on canvas background, not on nodes
          const target = e.target as HTMLElement;
          if (!target.classList.contains('react-flow__pane')) return;
          setCtxMenu({
            visible: true,
            position: { x: e.clientX, y: e.clientY },
            flowPosition: { x: e.clientX, y: e.clientY },
            hoverMenu: null,
          });
        }}
      >
        {/* Snap alignment lines */}
        <SnapLinesOverlay lines={snapLines} />

        {/* Grid background — togglable */}
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
        >
          {/* Custom control buttons will be rendered inside */}
        </Controls>

        {/* Zoom indicator */}
        <Panel position="bottom-right" className="flex items-center gap-2">
          <div className="flex items-center gap-2 bg-canvas-card border border-canvas-border rounded-lg px-3 py-1.5 shadow-lg">
            <button
              className={`w-7 h-7 rounded flex items-center justify-center transition-colors ${
                showGrid
                  ? 'text-indigo-400 hover:text-indigo-300 bg-indigo-500/15'
                  : 'text-canvas-text-secondary hover:text-canvas-text hover:bg-canvas-hover'
              }`}
              onClick={toggleGrid}
              data-tooltip={showGrid ? '隐藏背景网格' : '显示背景网格'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="5" cy="5" r="1.5" /><circle cx="12" cy="5" r="1.5" /><circle cx="19" cy="5" r="1.5" />
                <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
                <circle cx="5" cy="19" r="1.5" /><circle cx="12" cy="19" r="1.5" /><circle cx="19" cy="19" r="1.5" />
              </svg>
            </button>
            <button
              className={`w-7 h-7 rounded flex items-center justify-center transition-colors text-canvas-text-secondary hover:text-canvas-text hover:bg-canvas-hover`}
              onClick={() => setSmoothLine((v) => !v)}
              data-tooltip={smoothLine ? '连线类型：直角 → 切换为曲线' : '连线类型：曲线 → 切换为直角'}
            >
              {smoothLine ? (
                /* 直角折线图标 */
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M4 20 L10 20 L10 10 L20 4" />
                </svg>
              ) : (
                /* 贝塞尔曲线图标 */
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M4 20 Q12 8 20 4" />
                </svg>
              )}
            </button>
            <div className="w-px h-5 bg-canvas-border mx-0.5" />
            <input
              type="range"
              min="10"
              max="200"
              value={zoomPercent}
              onChange={handleZoomSlider}
              className="w-20 accent-indigo-500"
            />
            <span className="text-xs text-canvas-text-secondary w-10 text-right tabular-nums">{zoomPercent}%</span>
          </div>
        </Panel>

        {/* Empty state hint */}
        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
            <div className="flex flex-col items-center gap-4 opacity-50">
              <div className="w-16 h-16 rounded-2xl bg-canvas-card border border-canvas-border flex items-center justify-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2">
                  <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
                  <circle cx="2" cy="2" r="1.5" fill="#6366f1" />
                </svg>
              </div>
              <div className="text-center">
                <div className="text-lg font-medium text-canvas-text mb-1">双击画布</div>
                <div className="text-sm text-canvas-text-muted">自由生成节点，或从左侧面板选择节点类型</div>
              </div>
              <div className="flex gap-2 mt-2 pointer-events-auto">
                {(() => {
                  const labels: Partial<Record<NodeType, string>> = {
                    'ai-text': '生成文本',
                    'ai-image': '生成图像',
                    'ai-video': '生成视频',
                    'ai-audio': '生成音频',
                  };
                  return (['ai-text', 'ai-image', 'ai-video'] as NodeType[]).map((type) => (
                    <button
                      key={type}
                      onClick={() => {
                        const offset = Math.random() * 100;
                        addNode({
                          id: `node-${generateId()}`,
                          type,
                          position: { x: 250 + offset * 3, y: 200 + offset * 2 },
                          data: {
                            label: labels[type] || '',
                            type,
                            prompt: '',
                            status: 'idle',
                          },
                        });
                      }}
                      className="px-4 py-2 bg-canvas-card border border-canvas-border rounded-lg text-sm text-canvas-text-secondary hover:border-indigo-500/50 hover:text-canvas-text transition-all"
                    >
                      {labels[type]}
                    </button>
                  ));
                })()}
              </div>
            </div>
          </div>
        )}
      </ReactFlow>

      {/* ── 连线未命中时的"引用节点生成"菜单 ── */}
      {connectionMenu.visible && (
        <div
          ref={connectionMenuRef}
          className="fixed z-50 w-[260px] bg-canvas-card border border-canvas-border rounded-xl shadow-2xl shadow-black/50 overflow-hidden animate-in fade-in zoom-in-95 duration-150"
          style={{ left: connectionMenu.position.x, top: connectionMenu.position.y }}
        >
          {/* Header */}
          <div className="px-3 py-2.5 border-b border-canvas-border">
            <div className="text-[11px] font-medium text-canvas-text-muted uppercase tracking-wider mb-1">
              引用该节点生成
            </div>
            <div className="text-xs text-canvas-text-secondary truncate">
              {nodes.find((n) => n.id === connectionMenu.sourceNodeId)?.data?.label ?? '节点'}
            </div>
          </div>

          {/* Menu items */}
          <div className="p-1.5 space-y-0.5">
            {CONNECTION_MENU_MAP[connectionMenu.sourceNodeType]?.map((opt) => {
              const is360 = opt.special === '360-panorama';
              const iconColors: Record<string, string> = {
                'ai-text': 'text-indigo-400 bg-indigo-500/10',
                'ai-image': 'text-green-400 bg-green-500/10',
                'ai-video': 'text-blue-400 bg-blue-500/10',
                'ai-audio': 'text-orange-400 bg-orange-500/10',
              };
              const colorKey = is360 ? 'ai-image' : opt.type;
              const color = iconColors[colorKey] ?? 'text-canvas-text-secondary bg-canvas-hover';

              return (
                <button
                  key={`${opt.type}-${opt.label}`}
                  onClick={() => handleConnectionMenuSelect(opt)}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-canvas-hover transition-colors text-left group"
                >
                  <div className={`w-8 h-8 rounded-md ${color} flex items-center justify-center shrink-0`}>
                    {is360 ? (
                      /* 360 panoramic icon */
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <ellipse cx="12" cy="12" rx="6" ry="10" />
                        <line x1="12" y1="2" x2="12" y2="22" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                      </svg>
                    ) : opt.type === 'ai-text' ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="4 7 4 4 20 4 20 7" />
                        <line x1="9" y1="20" x2="15" y2="20" />
                        <line x1="12" y1="4" x2="12" y2="20" />
                      </svg>
                    ) : opt.type === 'ai-image' ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <polyline points="21 15 16 10 5 21" />
                      </svg>
                    ) : opt.type === 'ai-video' ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polygon points="23 7 16 12 23 17 23 7" />
                        <rect x="1" y="5" width="15" height="14" rx="2" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 18V5l12-2v13" />
                        <circle cx="6" cy="18" r="3" />
                        <circle cx="18" cy="16" r="3" />
                      </svg>
                    )}
                  </div>
                  <span className="text-sm text-canvas-text group-hover:text-white transition-colors">
                    {opt.label}
                  </span>
                  {is360 && (
                    <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400">
                      全景
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 右键上下文菜单 ── */}
      {ctxMenu.visible && (
        <>
          {/* Level 1: Root menu */}
          <div
            ref={ctxMenuRef}
            className="v2-canvas-ctx-menu"
            style={{ left: ctxMenu.position.x, top: ctxMenu.position.y }}
          >
            <div
              className={`v2-menu-row v2-menu-row-split${ctxMenu.hoverMenu === 'addNode' ? ' highlight' : ''}`}
              onMouseEnter={() => showSubmenu('addNode')}
              onMouseLeave={() => hideSubmenu(null)}
            >
              <span className="v2-menu-rowlabel">添加节点</span>
              <span className="v2-menu-arrow v2-menu-arrow-ml8">▶</span>
            </div>
            <div className="v2-menu-sep" />
            <div
              className={`v2-menu-row v2-menu-row-split${clipboard.length === 0 ? ' disabled' : ''}`}
              onClick={clipboard.length > 0 ? handleCtxPaste : undefined}
            >
              <span>粘贴</span>
              <span className="v2-menu-kbd">Ctrl V</span>
            </div>
            <div className="v2-menu-row v2-menu-row-split" onClick={handleCtxUndo}>
              <span>撤销</span>
              <span className="v2-menu-kbd">Ctrl Z</span>
            </div>
            <div className="v2-menu-row v2-menu-row-split" onClick={handleCtxRedo}>
              <span>重做</span>
              <span className="v2-menu-kbd">Ctrl Y</span>
            </div>
          </div>

          {/* Level 2: 添加节点 submenu — stay visible while navigating to Level 3 */}
          {(ctxMenu.hoverMenu === 'addNode' || ctxMenu.hoverMenu === 'genNode' || ctxMenu.hoverMenu === 'srcNode') && (
            <div
              ref={ctxSubmenuRef}
              className="v2-canvas-ctx-menu v2-submenu"
              style={{ left: ctxMenu.position.x + 180, top: ctxMenu.position.y + 4 }}
              onMouseEnter={() => showSubmenu('addNode')}
              onMouseLeave={() => hideSubmenu(null)}
            >
              <div
                className={`v2-menu-row v2-menu-row-split${ctxMenu.hoverMenu === 'genNode' ? ' highlight' : ''}`}
                onMouseEnter={() => showSubmenu('genNode')}
              >
                <span className="v2-menu-rowlabel">生成节点</span>
                <span className="v2-menu-arrow v2-menu-arrow-ml8">▶</span>
              </div>
              <div
                className={`v2-menu-row v2-menu-row-split${ctxMenu.hoverMenu === 'srcNode' ? ' highlight' : ''}`}
                onMouseEnter={() => showSubmenu('srcNode')}
              >
                <span className="v2-menu-rowlabel">源节点</span>
                <span className="v2-menu-arrow v2-menu-arrow-ml8">▶</span>
              </div>
            </div>
          )}

          {/* Level 3a: 生成节点 submenu */}
          {ctxMenu.hoverMenu === 'genNode' && (
            <div
              className="v2-canvas-ctx-menu v2-submenu"
              style={{ left: ctxMenu.position.x + 364, top: ctxMenu.position.y + 4 }}
              onMouseEnter={() => showSubmenu('genNode')}
              onMouseLeave={() => hideSubmenu('addNode')}
            >
              {GEN_NODE_ITEMS.map((item) => (
                <div
                  key={item.type}
                  className="v2-menu-row"
                  onClick={() => addNodeAtCtxPos(item.type, item.label, 'generator')}
                >
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          )}

          {/* Level 3b: 源节点 submenu */}
          {ctxMenu.hoverMenu === 'srcNode' && (
            <div
              className="v2-canvas-ctx-menu v2-submenu"
              style={{ left: ctxMenu.position.x + 364, top: ctxMenu.position.y + 36 }}
              onMouseEnter={() => showSubmenu('srcNode')}
              onMouseLeave={() => hideSubmenu('addNode')}
            >
              {SRC_NODE_ITEMS.map((item) => (
                <div
                  key={item.type}
                  className="v2-menu-row"
                  onClick={() => addNodeAtCtxPos(item.type, item.label, 'source')}
                >
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
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
