/**
 * useConnectionDropMenu 连线拖放菜单 Hook — 处理从节点输出 Handle 拖出连线时，弹出目标节点类型选择菜单并创建连线
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Node as RFNode, Edge, FinalConnectionState, Connection } from '@xyflow/react';
import { useAppStore, generateId } from '../store/useAppStore';
import { isCanvasConnectionValid } from '../store/store.nodes';
import type { BaseNodeData, NodeType } from '../types';
import { getPreferredNodeModel } from '../services/modelPreferenceService';
import { createUiNodeData } from '../services/uiNodeCreationData';

const SELECTION_MENU_TYPE = '__selection__';

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
  previewSources?: { x: number; y: number }[];
  sourceNodeIds?: string[];
  projectId?: string | null;
}

const CONNECTION_MENU_MAP: Record<string, ConnectionMenuOption[]> = {
  [SELECTION_MENU_TYPE]: [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
    { label: '生成音频', type: 'ai-audio' },
    { label: '帧动画', type: 'ai-animation' },
    { label: '生成360全景图', type: 'ai-panorama' },
  ],
  'ai-text': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
    { label: '生成音频', type: 'ai-audio' },
    { label: '帧动画', type: 'ai-animation' },
    { label: '生成360全景图', type: 'ai-panorama' },
  ],
  'ai-image': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
    { label: '帧动画', type: 'ai-animation' },
    { label: '生成360全景图', type: 'ai-panorama' },
  ],
  // 角色/素材库参考图是 source-image，连线能力与 ai-image 相同
  'source-image': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
    { label: '帧动画', type: 'ai-animation' },
    { label: '生成360全景图', type: 'ai-panorama' },
  ],
  'ai-storyboard': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
    { label: '帧动画', type: 'ai-animation' },
    { label: '生成360全景图', type: 'ai-panorama' },
  ],
  'ai-director': [
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
  ],
  'ai-video': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成视频', type: 'ai-video' },
  ],
  'source-video': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成视频', type: 'ai-video' },
  ],
  'ai-audio': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成音频', type: 'ai-audio' },
  ],
  'ai-panorama': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
  ],
  'ai-markdown': [],
  'ai-shotlist': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
  ],
};

const CONNECTION_NODE_LABELS: Partial<Record<NodeType, string>> = {
  'ai-text': '生成文本',
  'ai-image': '生成图像',
  'ai-video': '生成视频',
  'ai-audio': '生成音频',
  'ai-animation': '帧动画',
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
  const addNodeFromSelection = useAppStore((s) => s.addNodeFromSelection);
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

  const openSelectionMenu = useCallback((
    sourceNodeIds: string[],
    projectId: string | null,
    position: { x: number; y: number },
    sourcePoints?: { x: number; y: number }[],
  ) => {
    if (sourceNodeIds.length < 2 || useAppStore.getState().currentProjectId !== projectId) return;
    setMenu({
      visible: true,
      sourceNodeId: '',
      sourceNodeType: SELECTION_MENU_TYPE,
      sourceHandleId: 'right',
      direction: 'output',
      position,
      previewSources: sourcePoints?.map((point) => reactFlowInstance.screenToFlowPosition(point)),
      sourceNodeIds,
      projectId,
    });
  }, [reactFlowInstance]);

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

      const sourceElement = Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]'))
        .find((element) => element.dataset.id === fromNode.id);
      const handleElement = sourceElement?.querySelector<HTMLElement>(`.react-flow__handle-${direction === 'input' ? 'left' : 'right'}`);
      const handleRect = handleElement?.getBoundingClientRect();
      const nodeRect = sourceElement?.getBoundingClientRect();
      const sourcePoint = handleRect && handleRect.width > 0 && handleRect.height > 0
        ? { x: handleRect.left + handleRect.width / 2, y: handleRect.top + handleRect.height / 2 }
        : nodeRect
          ? { x: direction === 'input' ? nodeRect.left : nodeRect.right, y: nodeRect.top + nodeRect.height / 2 }
          : null;

      setMenu({
        visible: true,
        sourceNodeId: fromNode.id,
        sourceNodeType: sourceType,
        sourceHandleId,
        direction,
        position: clientPosition,
        previewSources: sourcePoint ? [reactFlowInstance.screenToFlowPosition(sourcePoint)] : undefined,
      });
    },
    [connectNodes, reactFlowInstance],
  );

  const handleSelect = useCallback(
    (option: ConnectionMenuOption) => {
      const { sourceNodeId, sourceHandleId, position } = menu;
      const flowPos = reactFlowInstance.screenToFlowPosition({ x: position.x, y: position.y });

      const data = createUiNodeData(option.type, option.label);
      const { nodeWidth: newWidth, nodeHeight: newHeight } = data;

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
      const defaultModel = option.type === 'ai-director' ? null : getPreferredNodeModel(option.type, useAppStore.getState());
      const newNode: RFNode<BaseNodeData> = {
        id: newNodeId,
        type: option.type,
        position: { x: nodeX, y: nodeY },
        data: {
          ...data,
          ...(option.type === 'ai-panorama' ? { previewMode: 'image' } : {}),
          ...defaultModel,
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
      if (menu.sourceNodeIds) {
        addNodeFromSelection(newNode, menu.sourceNodeIds, menu.projectId ?? null);
      } else {
        addNodeWithEdge(newNode, edge);
      }
      setMenu((s) => ({ ...s, visible: false }));
    },
    [menu, reactFlowInstance, addNodeWithEdge, addNodeFromSelection, smoothLine],
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
    openSelectionMenu,
    handleSelect,
    closeMenu: close,
    connectionMenuMap,
  };
}
