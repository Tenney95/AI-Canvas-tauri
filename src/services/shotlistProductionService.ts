/** 从指定镜头准备制作节点；不启动模型或导演运行时。 */
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData, NodeType } from '../types';
import type { ShotlistProductionKind } from '../types/shotlist';
import { buildShotFramePrompt, formatShotRowBrief } from '../types/shotlist';
import { generateId } from '../store/store.utils';
import { getShotlist, type ShotlistScope } from './shotlistService';

export const MAX_SHOTLIST_PRODUCTION_BATCH = 12;
const NODE_TYPES: Record<ShotlistProductionKind, NodeType> = { voiceover: 'ai-audio', video: 'ai-video', director: 'ai-director' };
const LABELS: Record<ShotlistProductionKind, string> = { voiceover: '配音', video: '视频', director: '导演台' };

export function prepareShotlistProduction(scope: ShotlistScope, nodeId: string, rowIds: string[], kind: ShotlistProductionKind) {
  const { state, node: sheet, rows } = getShotlist(scope, nodeId);
  if (!Object.hasOwn(NODE_TYPES, kind)) throw new Error('不支持的制作节点类型');
  if (!rowIds.length || rowIds.length > MAX_SHOTLIST_PRODUCTION_BATCH || new Set(rowIds).size !== rowIds.length) {
    throw new Error(`每次请选择 1 到 ${MAX_SHOTLIST_PRODUCTION_BATCH} 个不同镜头`);
  }
  // 先验证完整批次，避免后面的无效镜头留下半批节点。
  const selected = rowIds.map((rowId) => {
    const row = rows.find((item) => item.id === rowId);
    if (!row) throw new Error('镜头已删除，请重新选择');
    if (kind === 'voiceover' && !row.dialogue?.trim()) throw new Error('所选镜头没有对白，请先补充对白');
    if (kind !== 'voiceover' && !buildShotFramePrompt(row)) throw new Error('所选镜头没有画面描述');
    return row;
  });
  const nodes: Node<BaseNodeData>[] = [];
  const edges: Edge[] = [];
  const right = state.nodes.filter((item) => item.parentId === sheet.parentId)
    .reduce((value, item) => Math.max(value, item.position.x + (Number(item.data.nodeWidth) || 320)), 0) + 80;
  const connect = (source: string, target: string) => edges.push({ id: generateId(), source, target, sourceHandle: 'right', targetHandle: 'left' });
  const results = selected.map((row, index) => {
    const existing = state.nodes.filter((item) => item.type === NODE_TYPES[kind]
      && item.data.shotlistProductionSource?.nodeId === nodeId
      && item.data.shotlistProductionSource.rowId === row.id && item.data.shotlistProductionSource.kind === kind);
    if (existing.length > 1) throw new Error('此镜头有多个制作节点，请先在画布核对来源');
    if (existing.length) return { rowId: row.id, nodeId: existing[0].id, status: 'reused' as const };
    const targetId = `node-${generateId()}`;
    const label = `镜${row.shotNo.slice(0, 48)} ${LABELS[kind]}`;
    const position = { x: right, y: sheet.position.y + index * 340 };
    const data: BaseNodeData = {
      type: NODE_TYPES[kind], label, role: 'generator', status: 'idle', nodeWidth: 320, nodeHeight: 240,
      shotlistProductionSource: { nodeId, rowId: row.id, kind },
    };
    if (kind === 'voiceover') {
      // 语音模型的输入是实际要朗读的文字，不混入画面、运镜和音效说明。
      data.prompt = row.dialogue!.trim();
      data.audioPurpose = 'speech';
    } else if (kind === 'video') {
      data.prompt = buildShotFramePrompt(row);
      const frame = state.nodes.find((item) => item.id === row.frame?.nodeId
        && ['ai-image', 'source-image', 'ai-video', 'source-video'].includes(item.type ?? ''));
      if (frame) {
        const safeLabel = (frame.data.label || '画面').replace(/[{}:\r\n]/g, ' ').slice(0, 80);
        data.prompt += `\n参考画面：@{${frame.id}:${safeLabel}}`;
        connect(frame.id, targetId);
      }
    } else {
      const briefId = `node-${generateId()}`;
      nodes.push({ id: briefId, type: 'source-text', parentId: sheet.parentId, position: { ...position }, data: {
        type: 'source-text', role: 'source', label: `${label} 镜头说明`, status: 'success',
        output: [formatShotRowBrief(row), row.note?.trim()].filter(Boolean).join('\n'), nodeWidth: 320, nodeHeight: 220,
      } });
      position.x += 400;
      connect(briefId, targetId);
      // 不构造导演 Scene，不填原生路径，也不触发安装或打开编辑器。
      data.directorStatus = 'idle';
    }
    nodes.push({ id: targetId, type: data.type, parentId: sheet.parentId, position: { ...position }, data });
    connect(targetId, nodeId);
    return { rowId: row.id, nodeId: targetId, status: 'created' as const };
  });
  if (nodes.length) {
    state.addNodesWithEdges(nodes, edges);
    state.incrementRevision();
  }
  state.setSelectedNodeIds(results.map((item) => item.nodeId));
  return results;
}
