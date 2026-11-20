/** 唯一允许的引用：新项目自有内容寻址的单张原始图片。 */
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/useAppStore';
import type { CanvasContext } from '../types/project';
import { getProjectDataDir } from './fileService';
import { getRelativeAssetPath } from './fs/assetIndex';
import { localMediaUrlToPath } from '../utils/mediaUrl';
import { sha256BytesHex } from './mediaDataUrl';
import { isProjectExpectedContextCurrent } from './projectExecutionContext';

export interface NativeVideoImageReference {
  sourceNodeId: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}

export function validateNativeVideoImageReference(reference: NativeVideoImageReference): void {
  if (!reference || typeof reference !== 'object' || typeof reference.relativePath !== 'string') throw new Error('原参考图片身份无效');
  const match = /^media\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/.exec(reference.relativePath);
  const mime = match?.[2] === 'jpg' ? 'image/jpeg' : match ? `image/${match[2]}` : undefined;
  if (!reference || typeof reference.sourceNodeId !== 'string' || !reference.sourceNodeId || reference.sourceNodeId.length > 256
    || !match || match[1] !== reference.sha256 || mime !== reference.mimeType
    || !Number.isSafeInteger(reference.bytes) || reference.bytes <= 0 || reference.bytes >= 30 * 1024 * 1024
    || Object.keys(reference).some((key) => !['sourceNodeId', 'relativePath', 'sha256', 'bytes', 'mimeType'].includes(key))) {
    throw new Error('原参考图片身份无效，未提交视频任务');
  }
}

/** 原生端以不跟随链接的只读句柄检查大小与 SHA-256，结果仅保留本轮内存。 */
export async function readNativeVideoImageReference(projectId: string, reference: NativeVideoImageReference): Promise<Uint8Array> {
  validateNativeVideoImageReference(reference);
  const raw = await invoke<number[]>('read_native_project_media', { projectId, reference: {
    relativePath: reference.relativePath, sha256: reference.sha256, bytes: reference.bytes, mimeType: reference.mimeType,
  } });
  const bytes = new Uint8Array(raw);
  if (bytes.length !== reference.bytes || await sha256BytesHex(bytes) !== reference.sha256) throw new Error('原参考图片内容已变化');
  return bytes;
}

/** 重新核对连线和项目归属，再以原生受控读取校验原字节。 */
export async function verifyNativeVideoImageReference(context: CanvasContext, videoNodeId: string,
  reference: NativeVideoImageReference): Promise<Uint8Array> {
  const state = useAppStore.getState();
  if (!isProjectExpectedContextCurrent(context, state, { checkCanvasRevision: false })) throw new Error('原画布已切换');
  const links = state.edges.filter((edge) => edge.target === videoNodeId);
  const source = state.nodes.find((node) => node.id === reference.sourceNodeId);
  if (links.length !== 1 || links[0].source !== reference.sourceNodeId || !source || source.data.type !== 'source-image'
    || source.data.relativePath !== reference.relativePath || !source.data.filePath || !source.data.imageUrl) throw new Error('原参考图片或连线已变化');
  const root = await getProjectDataDir(context.canvasId), urlPath = localMediaUrlToPath(source.data.imageUrl);
  if (!root || !urlPath || getRelativeAssetPath(source.data.filePath, root) !== reference.relativePath
    || getRelativeAssetPath(urlPath, root) !== reference.relativePath) throw new Error('原参考图片归属已变化');
  const bytes = await readNativeVideoImageReference(context.projectId, reference);
  const latest = useAppStore.getState();
  if (!isProjectExpectedContextCurrent(context, latest, { checkCanvasRevision: false }) || latest.edges !== state.edges
    || latest.nodes.find((node) => node.id === reference.sourceNodeId)?.data !== source.data) throw new Error('原参考图片或画布已变化');
  return bytes;
}
