/** 会话属于作品，历史新结构会话可能以该作品的画布 ID 保存。 */
import type { CanvasProject } from '../../types';
import type { NativeProjectViewItem } from '../../store/nativeProjectView';
import { seriesOwnerId } from '../../store/store.utils';
import { getNativeProjectOwner } from '../fs/core';

const retiredCanvasIdsByProject = new Map<string, ReadonlySet<string>>();

function binding(project: CanvasProject | undefined) {
  return (project as NativeProjectViewItem | undefined)?.nativeView;
}

export function resolveConversationProjectScope(projects: CanvasProject[], projectId: string) {
  const target = projects.find((item) => item.id === projectId);
  const nativeProjectId = binding(target)?.projectId
    ?? (!target && projects.some((item) => binding(item)?.projectId === projectId) ? projectId : undefined);
  const ownerId = nativeProjectId ?? seriesOwnerId(projects, projectId);
  const projectIds = new Set([ownerId]);
  if (nativeProjectId) {
    for (const project of projects) {
      const view = binding(project);
      if (view && view.projectId === nativeProjectId && view.canvasId === project.id) projectIds.add(project.id);
    }
    for (const id of retiredCanvasIdsByProject.get(nativeProjectId) ?? []) projectIds.add(id);
  }
  return { ownerId, projectIds, nativeProjectId };
}

/** 墓碑画布不参与执行；只沿权威归属补回它以前持有的会话。 */
export async function refreshRetiredConversationCanvasIds(projectId: string): Promise<void> {
  const { listNativeRetiredCanvasIds } = await import('../indexedDb/nativeProjectRepository');
  const retired = await listNativeRetiredCanvasIds(projectId);
  if (retired.length) retiredCanvasIdsByProject.set(projectId, new Set([...(retiredCanvasIdsByProject.get(projectId) ?? []), ...retired]));
}

export function isConversationInProjectScope(projects: CanvasProject[], projectId: string, conversationProjectId: string): boolean {
  return resolveConversationProjectScope(projects, projectId).projectIds.has(conversationProjectId);
}

export function resolveNativeConversationCanvas(projects: CanvasProject[], canvasId: string | null, conversationProjectId: string): string | undefined {
  if (!canvasId || binding(projects.find((item) => item.id === canvasId))?.canvasId !== canvasId) return undefined;
  return isConversationInProjectScope(projects, canvasId, conversationProjectId) ? canvasId : undefined;
}

/** 持久化写入只认已登记归属和原生墓碑，不能用页面投影替代核验。 */
export function isRegisteredNativeConversationAlias(projectId: string, conversationProjectId: string): boolean {
  return getNativeProjectOwner(conversationProjectId) === projectId
    || retiredCanvasIdsByProject.get(projectId)?.has(conversationProjectId) === true;
}

export function doesNativeExecutionOwnConversation(projectOrCanvasId: string, conversationProjectId: string): boolean {
  if (projectOrCanvasId === conversationProjectId) return true;
  const projectId = getNativeProjectOwner(projectOrCanvasId);
  return !!projectId && (conversationProjectId === projectId || isRegisteredNativeConversationAlias(projectId, conversationProjectId));
}
