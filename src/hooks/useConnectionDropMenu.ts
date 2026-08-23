/**
 * useConnectionDropMenu 连线拖放菜单 Hook — 处理从节点输出 Handle 拖出连线时，弹出目标节点类型选择菜单并创建连线
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Node as RFNode, Edge, FinalConnectionState, Connection } from '@xyflow/react';
import { useAppStore, generateId } from '../store/useAppStore';
import { isCanvasConnectionValid } from '../store/store.nodes';
import type { BaseNodeData, NodeType } from '../types';

// ── Model preference helper ──
const MODEL_PREF_KEY = 'canvas-model-prefs';

function loadDefaultModel(nodeType: string): { model: string; provider: string } | null {
  try {
    const raw = localStorage.getItem(MODEL_PREF_KEY);
    if (!raw) return null;
    const prefs: Record<string, string> = JSON.parse(raw);
    // 全景图和动画节点回退到生图偏好
    const modelValue = prefs[nodeType]
      || (nodeType === 'ai-panorama' || nodeType === 'ai-animation' ? prefs['ai-image'] : undefined);
    if (!modelValue) return null;
    const slashIdx = modelValue.indexOf('/');
    if (slashIdx === -1) return null;
    const provider = modelValue.slice(0, slashIdx);
    if (!provider) return null;
    return { model: modelValue, provider };
  } catch {
    return null;
  }
}

interface ConnectionMenuOption {
  label: string;
  type: NodeType;
}

export type ConnectionMenuDirection = 'input' | 'output';

interface ConnectionMenuState {
  visible: boolean;
  sourceNodeId: string;
  sourceNodeType: string;
  sourceHandleId: string | null;
  direction: ConnectionMenuDirection;
  position: { x: number; y: number };
}

const CONNECTION_MENU_MAP: Record<string, ConnectionMenuOption[]> = {
  'ai-text': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
    { label: '生成音频', type: 'ai-audio' },
    { label: '生成动画', type: 'ai-animation' },
    { label: '生成360全景图', type: 'ai-panorama' },
  ],
  'ai-image': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
    { label: '生成动画', type: 'ai-animation' },
    { label: '生成360全景图', type: 'ai-panorama' },
  ],
  'ai-storyboard': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
    { label: '生成动画', type: 'ai-animation' },
    { label: '生成360全景图', type: 'ai-panorama' },
  ],
  'ai-director': [
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
  ],
  'ai-video': [],
  'ai-audio': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成音频', type: 'ai-audio' },
  ],
  'ai-panorama': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
  ],
  'ai-markdown': [],
  // 分镜表的下游产物是时间轴，不是再生成一个媒体节点
  'ai-shotlist': [],
};

const CONNECTION_NODE_LABELS: Partial<Record<NodeType, string>> = {
  'ai-text': '生成文本',
  'ai-image': '生成图像',
  'ai-video': '生成视频',
  'ai-audio': '生成音频',
  'ai-animation': '生成动画',
  'ai-panorama': '生成360全景图',
  'ai-storyboard': '生成分镜',
  'ai-director': '导演台',
};

const INPUT_CONNECTION_MENU_MAP: Record<string, ConnectionMenuOption[]> = Object.fromEntries(
  Object.keys(CONNECTION_MENU_MAP).map((targetType) => [
    targetType,
    Object.entries(CONNECTION_MENU_MAP).flatMap(([candidateType, outputs]) => {
      const type = candidateType as NodeType;
      const label = CONNECTION_NODE_LABELS[type];
      return label && outputs.some((option) => option.type === targetType)
        ? [{ label, type }]
        : [];
    }),
  ]),
);

function getClientPosition(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('changedTouches' in event) {
    const touch = event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return { x: event.clientX, y: event.clientY };
}

export function resolveNodeBodyHandle(clientX: number, left: number, width: number): 'left' | 'right' {
  return clientX < left + width / 2 ? 'left' : 'right';
}

export function getConnectionMenuOptions(
  nodeType: string,
  direction: ConnectionMenuDirection,
): ConnectionMenuOption[] {
  const menuMap = direction === 'input' ? INPUT_CONNECTION_MENU_MAP : CONNECTION_MENU_MAP;
  return menuMap[nodeType] ?? [];
}

export function useConnectionDropMenu(smoothLine: boolean) {
  const reactFlowInstance = useReactFlow();
  const addNodeWithEdge = useAppStore((s) => s.addNodeWithEdge);
  const connectNodes = useAppStore((s) => s.onConnect);
  const nodes = useAppStore((s) => s.nodes);

  const [menu, setMenu] = useState<ConnectionMenuState>({
    visible: false,
    sourceNodeId: '',
    sourceNodeType: '',
    sourceHandleId: null,
    direction: 'output',
    position: { x: 0, y: 0 },
  });
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setMenu((s) => ({ ...s, visible: false }));
  }, []);

  // Close on click outside or Escape
  useEffect(() => {
    if (!menu.visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Element)) {
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    // 捕获阶段监听：传统交互模式下左键平移会被 React Flow(d3-zoom)在 pane 上 stopPropagation，
    // 冒泡阶段的 document 监听收不到事件，必须在捕获阶段先于其触发才能关闭菜单。
    document.addEventListener('mousedown', onClick, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick, true);
    };
  }, [menu.visible, close]);

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (connectionState.isValid === true) return;
      if (!connectionState.fromNode) return;

      const clientPosition = getClientPosition(event);
      if (!clientPosition) return;
      const hitNodeElement = document
        .elementFromPoint(clientPosition.x, clientPosition.y)
        ?.closest<HTMLElement>('.react-flow__node[data-id]');
      const hitNodeId = hitNodeElement?.dataset.id;
      if (hitNodeElement && hitNodeId) {
        if (hitNodeId === connectionState.fromNode.id) return;
        const rect = hitNodeElement.getBoundingClientRect();
        const targetHandle = resolveNodeBodyHandle(clientPosition.x, rect.left, rect.width);
        const connection: Connection = {
          source: connectionState.fromNode.id,
          sourceHandle: connectionState.fromHandle?.id ?? null,
          target: hitNodeId,
          targetHandle,
        };
        if (isCanvasConnectionValid(connection)) connectNodes(connection);
        return;
      }

      const fromNode = connectionState.fromNode as RFNode;
      const sourceType = fromNode.type;
      const sourceHandleId = connectionState.fromHandle?.id ?? null;
      const direction = sourceHandleId === 'left' ? 'input' : 'output';
      if (!sourceType || getConnectionMenuOptions(sourceType, direction).length === 0) return;

      setMenu({
        visible: true,
        sourceNodeId: fromNode.id,
        sourceNodeType: sourceType,
        sourceHandleId,
        direction,
        position: clientPosition,
      });
    },
    [connectNodes],
  );

  const handleSelect = useCallback(
    (option: ConnectionMenuOption) => {
      const { sourceNodeId, sourceHandleId, position } = menu;
      const flowPos = reactFlowInstance.screenToFlowPosition({ x: position.x, y: position.y });

      const isAnimation = option.type === 'ai-animation';
      const isDirector = option.type === 'ai-director';
      const newWidth = isAnimation || isDirector ? 320 : option.type === 'ai-audio' ? 260 : option.type === 'ai-panorama' ? 300 : 280;
      const newHeight = isDirector
        ? 240
        : isAnimation
          ? 358
          : option.type === 'ai-audio'
            ? 140
            : option.type === 'ai-image'
              ? 158
              : option.type === 'ai-panorama'
                ? 200
                : option.type === 'ai-markdown'
                  ? 200
                  : 160;

      // 输入/输出语义由开始拖拽的 Handle 决定，不再随空白落点跨过节点而翻转。
      const edgeSourceHandle = sourceHandleId === 'left' ? 'left' : 'right';
      const edgeTargetHandle = edgeSourceHandle === 'left' ? 'right' : 'left';

      // Position at the drop point:
      // - left side:  right edge of new node aligns with cursor  (nodeX = flowPos.x - newWidth)
      // - right side: left edge of new node aligns with cursor   (nodeX = flowPos.x)
      let nodeX: number;
      if (edgeSourceHandle === 'left') {
        nodeX = flowPos.x - newWidth;
      } else {
        nodeX = flowPos.x;
      }
      const nodeY = flowPos.y - newHeight / 2;

      const newNodeId = `node-${generateId()}`;
      const defaultModel = loadDefaultModel(option.type);
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
          ...(option.type === 'ai-panorama' ? { previewMode: 'image' } : {}),
          ...(isAnimation ? {
            prompt: '2D俯视角游戏角色，保持角色造型、朝向、比例和光照一致',
            animationAction: 'idle' as const,
            animationFrames: 8 as const,
            animationPreviewMode: 'playing' as const,
            aspectRatio: '1:1',
            imageSize: '2K',
          } : {}),
          ...(isDirector ? {
            role: 'source' as const,
            directorStatus: 'idle' as const,
            directorCaptureUrls: [] as string[],
          } : {}),
          ...(defaultModel && !isDirector ? { model: defaultModel.model, provider: defaultModel.provider } : {}),
        },
      };
      const edge: Edge = {
        id: `edge-${generateId()}`,
        // 新节点建在原节点左侧时，原节点的左接口是输入；方向必须反转为新节点右出、原节点左入。
        source: edgeSourceHandle === 'left' ? newNodeId : sourceNodeId,
        sourceHandle: edgeSourceHandle === 'left' ? edgeTargetHandle : edgeSourceHandle,
        target: edgeSourceHandle === 'left' ? sourceNodeId : newNodeId,
        targetHandle: edgeSourceHandle === 'left' ? edgeSourceHandle : edgeTargetHandle,
        type: smoothLine ? 'smoothstep' : 'default',
      };
      addNodeWithEdge(newNode, edge);
      setMenu((s) => ({ ...s, visible: false }));
    },
    [menu, reactFlowInstance, addNodeWithEdge, smoothLine],
  );

  const sourceNode = nodes.find((n) => n.id === menu.sourceNodeId);
  const connectionMenuMap = menu.direction === 'input'
    ? INPUT_CONNECTION_MENU_MAP
    : CONNECTION_MENU_MAP;

  return {
    menu,
    menuRef,
    sourceNode,
    handleConnectEnd,
    handleSelect,
    closeMenu: close,
    connectionMenuMap,
  };
}
