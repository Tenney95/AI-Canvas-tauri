/** 菜单导入共用正文解码、节点装配与异步画布守卫。 */
import { useAppStore, computeImageNodeDimensions, generateId } from '../store/useAppStore';
import type { BaseNodeData } from '../types';
import { classifyFile } from '../utils/sourceFileType';
import { readBinaryFile, uploadSourceFileToProject } from './fileService';
import { registerCanvasImport, isCanvasDerivationFresh, completeCanvasDerivation } from './canvasDerivationGuard';

export async function importSourceFileToCanvas(position: { x: number; y: number }): Promise<void> {
  const state = useAppStore.getState();
  const guard = registerCanvasImport(state);
  if (!guard) return;
  const isFresh = () => isCanvasDerivationFresh(guard, useAppStore.getState());
  try {
    const result = await uploadSourceFileToProject('*/*', guard.projectId);
    if (!result || !isFresh()) return;
    const category = classifyFile(result.fileName.split('.').pop() ?? '');
    if (!category) throw new Error('不支持的文件类型');
    const type = `ai-${category}` as BaseNodeData['type'];
    const data: BaseNodeData = {
      label: result.fileName, type, role: 'source', status: 'success',
      fileName: result.fileName, filePath: result.filePath,
      nodeWidth: category === 'audio' ? 260 : 280, nodeHeight: 160,
    };
    if (category === 'text') {
      // 桌面返回本地资产地址，浏览器返回 data URL；两者都先还原文件字节。
      const bytes = result.filePath ? await readBinaryFile(result.filePath)
        : Uint8Array.from(atob(result.dataUrl.slice(result.dataUrl.indexOf(',') + 1)), (char) => char.charCodeAt(0));
      data.output = new TextDecoder('utf-8').decode(bytes);
      data.prompt = '';
    } else {
      data[category === 'image' ? 'imageUrl' : category === 'video' ? 'videoUrl' : 'audioUrl'] = result.dataUrl;
      if (category === 'image') Object.assign(data, await computeImageNodeDimensions(result.dataUrl));
    }
    if (!isFresh()) return;
    useAppStore.getState().addNode({ id: `node-${generateId()}`, type, position, data });
  } catch (error) {
    if (isFresh()) throw error;
  } finally {
    completeCanvasDerivation(guard);
  }
}
