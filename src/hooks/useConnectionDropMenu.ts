/**
 * useConnectionDropMenu 连线拖放菜单 Hook — 处理从节点输出 Handle 拖出连线时，弹出目标节点类型选择菜单并创建连线
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Node as RFNode, Edge, FinalConnectionState } from '@xyflow/react';
import { useAppStore, generateId } from '../store/useAppStore';
import type { BaseNodeData, NodeType } from '../types';

interface ConnectionMenuOption {
  label: string;
  type: NodeType;
}

interface ConnectionMenuState {
  visible: boolean;
  sourceNodeId: string;
  sourceNodeType: string;
  sourceHandleId: string | null;
  position: { x: number; y: number };
}

const CONNECTION_MENU_MAP: Record<string, ConnectionMenuOption[]> = {
  'ai-text': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
    { label: '生成音频', type: 'ai-audio' },
    { label: '生成360全景图', type: 'ai-panorama' },
    { label: 'Markdown 文档', type: 'ai-markdown' },
  ],
  'ai-image': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: '生成视频', type: 'ai-video' },
    { label: '生成360全景图', type: 'ai-panorama' },
    { label: 'Markdown 文档', type: 'ai-markdown' },
  ],
  'ai-video': [],
  'ai-audio': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成音频', type: 'ai-audio' },
    { label: 'Markdown 文档', type: 'ai-markdown' },
  ],
  'ai-panorama': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: 'Markdown 文档', type: 'ai-markdown' },
  ],
  'ai-markdown': [
    { label: '生成文本', type: 'ai-text' },
    { label: '生成图像', type: 'ai-image' },
    { label: 'Markdown 文档', type: 'ai-markdown' },
  ],
};

export function useConnectionDropMenu(smoothLine: boolean) {
  const reactFlowInstance = useReactFlow();
  const addNodeWithEdge = useAppStore((s) => s.addNodeWithEdge);
  const nodes = useAppStore((s) => s.nodes);

  const [menu, setMenu] = useState<ConnectionMenuState>({
    visible: false,
    sourceNodeId: '',
    sourceNodeType: '',
    sourceHandleId: null,
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
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menu.visible, close]);

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (connectionState.isValid === true) return;
      if (!connectionState.fromNode) return;

      const fromNode = connectionState.fromNode as RFNode;
      const sourceType = fromNode.type;
      if (!sourceType || !CONNECTION_MENU_MAP[sourceType]?.length) return;

      const mouseEvt = event as MouseEvent;
      setMenu({
        visible: true,
        sourceNodeId: fromNode.id,
        sourceNodeType: sourceType,
        sourceHandleId: connectionState.fromHandle?.id ?? null,
        position: { x: mouseEvt.clientX, y: mouseEvt.clientY },
      });
    },
    [],
  );

  const handleSelect = useCallback(
    (option: ConnectionMenuOption) => {
      const { sourceNodeId, sourceHandleId, position } = menu;
      const flowPos = reactFlowInstance.screenToFlowPosition({ x: position.x, y: position.y });

      const sourceNode = reactFlowInstance.getNode(sourceNodeId) as RFNode<BaseNodeData> | undefined;
      const srcX = sourceNode?.position?.x ?? 0;
      const srcWidth = (sourceNode?.data?.nodeWidth as number | undefined) ?? 280;
      const srcRight = srcX + srcWidth;

      const newWidth = option.type === 'ai-audio' ? 260 : option.type === 'ai-panorama' ? 300 : 280;
      const newHeight = option.type === 'ai-audio' ? 140 : option.type === 'ai-image' ? 158 : option.type === 'ai-panorama' ? 200 : option.type === 'ai-markdown' ? 200 : 160;

      // Determine handle direction based on position relative to source
      const releasedRight = flowPos.x >= srcRight + 10;
      const releasedLeft = flowPos.x <= srcX - 10;

      let edgeSourceHandle: string | undefined;
      let edgeTargetHandle: string | undefined;

      if (releasedRight) {
        edgeSourceHandle = 'right';
        edgeTargetHandle = 'left';
      } else if (releasedLeft) {
        edgeSourceHandle = 'left';
        edgeTargetHandle = 'right';
      } else {
        const handle = sourceHandleId;
        if (handle === 'left') {
          edgeSourceHandle = 'left';
          edgeTargetHandle = 'right';
        } else {
          edgeSourceHandle = 'right';
          edgeTargetHandle = 'left';
        }
      }

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
      addNodeWithEdge(newNode, edge);
      setMenu((s) => ({ ...s, visible: false }));
    },
    [menu, reactFlowInstance, addNodeWithEdge, smoothLine],
  );

  const sourceNode = nodes.find((n) => n.id === menu.sourceNodeId);

  return {
    menu,
    menuRef,
    sourceNode,
    handleConnectEnd,
    handleSelect,
    closeMenu: close,
    connectionMenuMap: CONNECTION_MENU_MAP,
  };
}
