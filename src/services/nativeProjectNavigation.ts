/** 新结构项目打开时组合单画布与共享资料；旧项目仍使用原有导航路径。 */
import { configValuesEqual } from './configPatch';
import {
  readNativeEpisodeContent, readNativeProjectContent, readNativeProjectSelection,
  type NativeProjectOptions,
} from './indexedDb/nativeProjectRepository';

export async function readNativeProjectView(projectId: string, canvasId?: string, options: NativeProjectOptions = {}) {
  const selection = await readNativeProjectSelection(projectId, canvasId, options);
  if (!selection) return null;
  const [shared, episode] = await Promise.all([
    readNativeProjectContent(projectId, options),
    selection.episode ? readNativeEpisodeContent(projectId, selection.episode.id, options) : Promise.resolve(null),
  ]);
  options.signal?.throwIfAborted();
  // 跨事务读取必须属于同一提交；后续保存仍须执行各域 CAS，不能把此快照当写入授权。
  if (!shared || shared.changeRevision !== selection.changeRevision
    || !configValuesEqual(shared.project, selection.project)
    || selection.episode && (!episode || episode.changeRevision !== selection.changeRevision
      || !configValuesEqual(episode.project, selection.project)
      || !configValuesEqual(episode.episode, selection.episode))) {
    throw new Error('项目在打开期间发生变化，请重新打开');
  }
  return { selection, content: shared.content, episodeContent: episode?.content ?? null };
}
