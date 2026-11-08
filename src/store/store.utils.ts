/**
 * Store utilities — pure functions: ID generation, image dimension calculation
 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData, CanvasProject } from '../types';

export const generateId = () => Math.random().toString(36).substring(2, 11);

export function generateProjectId(): string {
  return crypto.randomUUID();
}

/**
 * 剧集共享数据（角色库、素材目录、项目记忆）的归属项目 id。
 * 分集各有各的画布，但这些内容整部剧共用一份，统一挂在剧集项目上；
 * 普通项目和剧集项目本身归自己。
 */
export function seriesOwnerId(
  projects: Pick<CanvasProject, 'id' | 'parentId'>[],
  projectId: string,
): string {
  return projects.find((item) => item.id === projectId)?.parentId ?? projectId;
}

/** 新普通项目的画布与作品身份不同；项目记忆始终归作品所有。 */
export function projectMemoryOwnerId(projects: CanvasProject[], projectId: string): string {
  const project = projects.find((item) => item.id === projectId) as (CanvasProject & { nativeView?: { projectId: string } }) | undefined;
  return project?.nativeView?.projectId ?? seriesOwnerId(projects, projectId);
}

/** 某个剧集项目下的分集，按集号升序。 */
export function listEpisodes(projects: CanvasProject[], seriesId: string): CanvasProject[] {
  const episodes = projects.filter((item) => item.parentId === seriesId);
  // 新模型的显示集号与排序独立，旧项目仍按旧集号排序。
  const rank = (item: CanvasProject) => (item as CanvasProject & { nativeView?: { projectId: string; orderRank?: number } }).nativeView;
  const native = episodes.every((item) => rank(item)?.projectId === seriesId && Number.isSafeInteger(rank(item)?.orderRank));
  return episodes.sort((a, b) => native
    ? rank(a)!.orderRank! - rank(b)!.orderRank!
    : (a.episodeNo ?? 0) - (b.episodeNo ?? 0));
}

/** 项目标签与项目库只列顶层项目：普通项目和剧集项目，不列分集。 */
export function listTopLevelProjects(projects: CanvasProject[]): CanvasProject[] {
  return projects.filter((item) => !item.parentId);
}

/** 剧集项目自身没有画布，打开它等于打开它的第一集。 */
export function resolveOpenTargetId(projects: CanvasProject[], projectId: string): string {
  return listEpisodes(projects, projectId)[0]?.id ?? projectId;
}

export function computeImageNodeDimensions(dataUrl: string): Promise<{ nodeWidth: number; nodeHeight: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const naturalRatio = img.naturalWidth / img.naturalHeight;
      const maxWidth = 280;
      const minWidth = 160;
      let nodeWidth = img.naturalWidth;
      if (nodeWidth > maxWidth) nodeWidth = maxWidth;
      if (nodeWidth < minWidth) nodeWidth = minWidth;
      const contentWidth = nodeWidth - 4;
      const previewHeight = Math.round(contentWidth / naturalRatio);
      const nodeHeight = Math.max(120, previewHeight + 4);
      resolve({ nodeWidth, nodeHeight });
    };
    img.onerror = () => resolve({ nodeWidth: 280, nodeHeight: 158 });
    img.src = dataUrl;
  });
}

/**
 * 派生节点统一放在源节点右侧。
 * 源节点在分组里时坐标是相对父节点的，必须把 parentId 一起继承，
 * 否则同一份坐标落到画布原点系里，节点会跑到离源节点很远的地方。
 */
export function derivedNodePlacement(
  sourceNode: Pick<Node<BaseNodeData>, 'position' | 'parentId' | 'data'>,
  gap = 40,
): { position: { x: number; y: number }; parentId?: string } {
  const width = Number(sourceNode.data?.nodeWidth) || 280;
  return {
    position: { x: sourceNode.position.x + width + gap, y: sourceNode.position.y },
    ...(sourceNode.parentId ? { parentId: sourceNode.parentId } : {}),
  };
}

export function getNextDisplayId(nodes: Node<BaseNodeData>[]): number {
  let max = 9;
  for (const n of nodes) {
    const id = (n.data as BaseNodeData).displayId;
    if (typeof id === 'number' && id > max) max = id;
  }
  return max + 1;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
