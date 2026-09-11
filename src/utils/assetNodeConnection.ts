import type { Connection } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import type { InstalledPlugin } from '../types/plugin';
import type { AppState } from '../store/useAppStore';
import { useAppStore } from '../store/useAppStore';
import { isCanvasConnectionValid } from '../store/store.nodes';
import { getAvailablePluginNodes } from '../services/plugins/pluginRuntime';
import { resolveNodeBodyHandle } from '../hooks/useConnectionDropMenu';

export interface AssetNodePort {
  id: string;
  label: string;
  direction: 'input' | 'output';
}

export interface AssetNodeConnectionOrigin {
  projectId: string | null;
  nodeId: string;
  handleId: string;
}

export interface AssetNodeConnectionTarget {
  nodeId: string;
  handleId: string;
}

const STANDARD_HANDLE_TYPES = new Set([
  'ai-text', 'ai-image', 'ai-video', 'ai-audio', 'ai-animation', 'ai-panorama',
  'ai-markdown', 'ai-storyboard', 'ai-shotlist', 'ai-director',
  'source-text', 'source-image', 'source-video', 'source-audio', 'comment', 'group',
]);
const STANDARD_PORTS: AssetNodePort[] = [
  { id: 'left', label: '输入', direction: 'input' },
  { id: 'right', label: '输出', direction: 'output' },
];

/** 只代理真实节点已有的端口；笔记等无端口节点不创建虚构连接点。 */
export function getAssetNodePorts(data: BaseNodeData, plugins: InstalledPlugin[]): AssetNodePort[] {
  if (data.type === 'plugin-node') {
    const available = getAvailablePluginNodes(plugins).find((item) => (
      item.pluginId === data.pluginId && item.node.id === data.pluginNodeId
    ));
    if (!available) return [];
    return [
      ...available.node.inputs.map((port) => ({ id: `plugin-in-${port.id}`, label: port.label, direction: 'input' as const })),
      ...available.node.outputs.map((port) => ({ id: `plugin-out-${port.id}`, label: port.label, direction: 'output' as const })),
    ];
  }
  return STANDARD_HANDLE_TYPES.has(data.type) ? STANDARD_PORTS : [];
}

export function findAssetNodeConnectionTarget(clientX: number, clientY: number): AssetNodeConnectionTarget | null {
  const hit = document.elementFromPoint(clientX, clientY);
  const nodeElement = hit?.closest<HTMLElement>('.react-flow__node[data-id]');
  const nodeId = nodeElement?.dataset.id;
  if (!nodeElement || !nodeId) return null;
  const handle = hit?.closest<HTMLElement>('.react-flow__handle');
  if (handle) {
    if (!handle.classList.contains('connectableend')) return null;
    const handleId = handle.dataset.handleid;
    return handleId ? { nodeId, handleId } : null;
  }
  // 与画布原有“落到节点主体”交互一致；多端口插件需命中具体接口。
  const bounds = nodeElement.getBoundingClientRect();
  return { nodeId, handleId: resolveNodeBodyHandle(clientX, bounds.left, bounds.width) };
}

type ConnectionState = Pick<AppState, 'nodes' | 'edges' | 'currentProjectId' | 'installedPlugins'>;

export function resolveAssetNodeConnection(
  state: ConnectionState,
  origin: AssetNodeConnectionOrigin,
  target: AssetNodeConnectionTarget | null,
): Connection | null {
  if (!target || state.currentProjectId !== origin.projectId || origin.nodeId === target.nodeId) return null;
  const from = state.nodes.find((node) => node.id === origin.nodeId);
  const to = state.nodes.find((node) => node.id === target.nodeId);
  if (!from || !to) return null;
  const fromPort = getAssetNodePorts(from.data, state.installedPlugins).find((port) => port.id === origin.handleId);
  const toPort = getAssetNodePorts(to.data, state.installedPlugins).find((port) => port.id === target.handleId);
  if (!fromPort || !toPort || fromPort.direction === toPort.direction) return null;
  const connection: Connection = fromPort.direction === 'output'
    ? { source: from.id, sourceHandle: fromPort.id, target: to.id, targetHandle: toPort.id }
    : { source: to.id, sourceHandle: toPort.id, target: from.id, targetHandle: fromPort.id };
  if (!isCanvasConnectionValid(connection)) return null;
  const duplicate = state.edges.some((edge) => edge.source === connection.source && edge.target === connection.target
    && (edge.sourceHandle ?? 'right') === connection.sourceHandle && (edge.targetHandle ?? 'left') === connection.targetHandle);
  return duplicate ? null : connection;
}

/** 放开指针时重新读取项目、节点和端口，再由唯一 Store Action 写入真实连线与历史。 */
export function commitAssetNodeConnection(origin: AssetNodeConnectionOrigin, target: AssetNodeConnectionTarget | null): boolean {
  const state = useAppStore.getState();
  const connection = resolveAssetNodeConnection(state, origin, target);
  if (!connection) return false;
  state.onConnect(connection);
  return true;
}

interface DragPoint { x: number; y: number; valid: boolean }
interface DragStart {
  origin: AssetNodeConnectionOrigin;
  pointerId: number;
  onMove: (point: DragPoint) => void;
  onEnd: () => void;
}

/** 指针会话只存内存；面板卸载、Esc、失焦和项目/源端口失效时完整取消。 */
export function startAssetNodeConnectionDrag({ origin, pointerId, onMove, onEnd }: DragStart): () => void {
  let ended = false;
  let unsubscribe = () => {};
  const capture = { capture: true };
  const finish = () => {
    if (ended) return;
    ended = true;
    window.removeEventListener('pointermove', move, capture);
    window.removeEventListener('pointerup', up, capture);
    window.removeEventListener('pointercancel', cancel, capture);
    window.removeEventListener('blur', finish);
    document.removeEventListener('keydown', key, capture);
    unsubscribe();
    onEnd();
  };
  const move = (event: PointerEvent) => {
    if (ended || event.pointerId !== pointerId) return;
    const target = findAssetNodeConnectionTarget(event.clientX, event.clientY);
    onMove({ x: event.clientX, y: event.clientY, valid: !!resolveAssetNodeConnection(useAppStore.getState(), origin, target) });
  };
  const up = (event: PointerEvent) => {
    if (ended || event.pointerId !== pointerId) return;
    event.preventDefault();
    const target = findAssetNodeConnectionTarget(event.clientX, event.clientY);
    finish();
    commitAssetNodeConnection(origin, target);
  };
  const cancel = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(); };
  const key = (event: KeyboardEvent) => {
    if (ended || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    finish();
  };
  window.addEventListener('pointermove', move, capture);
  window.addEventListener('pointerup', up, capture);
  window.addEventListener('pointercancel', cancel, capture);
  window.addEventListener('blur', finish);
  document.addEventListener('keydown', key, capture);
  unsubscribe = useAppStore.subscribe((state) => {
    const node = state.nodes.find((item) => item.id === origin.nodeId);
    if (state.currentProjectId !== origin.projectId || !node
      || !getAssetNodePorts(node.data, state.installedPlugins).some((port) => port.id === origin.handleId)) finish();
  });
  return finish;
}
