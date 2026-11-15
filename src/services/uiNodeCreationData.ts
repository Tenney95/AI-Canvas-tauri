/**
 * UI 新建节点的初始数据；模型偏好、入口尺寸差异和 Store 写入由调用方处理。
 * 不用于 Agent/MCP、源文件导入或已有节点回填。
 */
import type { BaseNodeData, NodeType } from '../types';
import { SHOTLIST_DEFAULT_COLUMNS, createShotRow } from '../types';
import { generateId } from '../store/store.utils';

export function createUiNodeData(
  type: NodeType, label: string, role?: BaseNodeData['role'],
): BaseNodeData & { nodeWidth: number; nodeHeight: number } {
  const isAnimation = type === 'ai-animation';
  const isDirector = type === 'ai-director';
  const isShotlist = type === 'ai-shotlist';
  const isSource = role === 'source';
  return {
    label, type, ...(role ? { role } : {}), prompt: '', status: 'idle',
    nodeWidth: isShotlist ? 720 : isAnimation || isDirector ? 320
      : type === 'ai-audio' ? 260 : type === 'ai-panorama' ? 300 : 280,
    nodeHeight: isShotlist ? 380 : isDirector ? 240 : isAnimation ? 358
      : type === 'ai-audio' ? 140 : type === 'ai-image' ? 158
        : type === 'ai-panorama' || type === 'ai-markdown' ? 200 : 160,
    ...(type === 'ai-image' && !isSource ? { aspectRatio: '16:9', imageSize: '2K' } : {}),
    ...(isAnimation && !isSource ? {
      prompt: '2D俯视角游戏角色，保持角色造型、朝向、比例和光照一致',
      animationAction: 'idle' as const, animationFrames: 8 as const, animationPreviewMode: 'playing' as const,
      aspectRatio: '1:1', imageSize: '2K',
    } : {}),
    ...(isDirector ? {
      role: role ?? 'source', directorStatus: 'idle' as const, directorCaptureUrls: [],
    } : {}),
    ...(isShotlist ? {
      role: role ?? 'source', shotlistColumns: SHOTLIST_DEFAULT_COLUMNS,
      shotlistRows: [1, 2, 3].map((no) => createShotRow(`shot-${generateId()}`, no)),
    } : {}),
  };
}
