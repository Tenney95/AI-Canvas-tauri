/**
 * ai/connectedReferenceMedia — 收集连入某个生成节点的参考媒体。
 * 视频与音频生成共用：连线即引用，图片包含 3D 导演台截图。
 */
import { isRemoteMediaUrl } from '../../utils/mediaUrl';
import { useAppStore } from '../../store/useAppStore';
import { collectDirectorImageUrls } from '../directorDeskService';
import type { BaseNodeData } from '../../types';
import type { MediaReference, MediaReferenceKind } from '../../types/aiTypes';

export interface ConnectedReferenceMedia {
  references: MediaReference[];
  imageUrls: string[];
  videoUrls: string[];
  audioUrls: string[];
}

/** 远端模型优先复用生成结果原始公网 URL，本地工作流仍可直接读取 reference.url。 */
export function getMediaReferenceUrl(reference: MediaReference): string {
  return isRemoteMediaUrl(reference.sourceUrl) ? reference.sourceUrl.trim() : reference.url;
}

export function getMediaReferenceUrls(
  references: readonly MediaReference[],
  kind: MediaReferenceKind,
  target: 'remote' | 'local' = 'remote',
): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    if (reference.kind !== kind) continue;
    pushUniqueUrl(urls, seen, target === 'local' ? reference.url : getMediaReferenceUrl(reference));
  }
  return urls;
}

export function mergeMediaReferences(
  primary: readonly MediaReference[],
  additional: readonly MediaReference[],
): MediaReference[] {
  const references: MediaReference[] = [];
  const seen = new Set<string>();
  for (const reference of [...primary, ...additional]) {
    const url = reference.url.trim();
    const key = `${reference.kind}:${url}`;
    if (!url || seen.has(key)) continue;
    seen.add(key);
    references.push({ ...reference, url });
  }
  return references;
}

export function toLegacyReferenceMedia(references: readonly MediaReference[]): ConnectedReferenceMedia {
  return {
    references: [...references],
    imageUrls: getMediaReferenceUrls(references, 'image'),
    videoUrls: getMediaReferenceUrls(references, 'video'),
    audioUrls: getMediaReferenceUrls(references, 'audio'),
  };
}

/**
 * 参考素材的提醒阈值。真正的上限各家 Provider 不同（视频模型通常也就首尾两帧），
 * 这里只在明显超量时提醒一句，不做截断——留哪些该由用户决定，静默丢素材更难查。
 */
export const REFERENCE_SOFT_LIMIT = 10;

/** 引用素材明显超量时提醒一次；@ 一整张分镜表很容易一次带进十几张画面 */
export function warnIfTooManyReferences(counts: { image?: number; video?: number; audio?: number }): void {
  const total = (counts.image ?? 0) + (counts.video ?? 0) + (counts.audio ?? 0);
  if (total <= REFERENCE_SOFT_LIMIT) return;
  const detail = [
    counts.image ? `图 ${counts.image}` : '',
    counts.video ? `视频 ${counts.video}` : '',
    counts.audio ? `音频 ${counts.audio}` : '',
  ].filter(Boolean).join(' · ');
  useAppStore.getState().showToast(
    `本次带了 ${total} 项参考素材（${detail}），多数模型只认前 ${REFERENCE_SOFT_LIMIT} 项以内，多出来的会被忽略或直接报错`,
    'info',
  );
}

export function pushUniqueUrl(urls: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const url = value.trim();
  if (!url || seen.has(url)) return;
  seen.add(url);
  urls.push(url);
}

export function collectConnectedReferenceMedia(nodeId: string | undefined): ConnectedReferenceMedia {
  const empty: ConnectedReferenceMedia = { references: [], imageUrls: [], videoUrls: [], audioUrls: [] };
  if (!nodeId) return empty;
  const { nodes, edges } = useAppStore.getState();
  const sourceIds = edges.filter((e) => e.target === nodeId).map((e) => e.source);
  const references: MediaReference[] = [];

  const addReference = (
    kind: MediaReferenceKind,
    value: unknown,
    sourceNodeId: string,
    data: BaseNodeData,
  ) => {
    if (typeof value !== 'string' || !value.trim()) return;
    references.push({
      kind,
      url: value.trim(),
      origin: 'connection',
      role: kind === 'audio' ? 'reference_audio' : 'reference',
      sourceNodeId,
      filePath: data.filePath,
      sourceUrl: data.sourceUrl,
    });
  };

  for (const sid of sourceIds) {
    const node = nodes.find((n) => n.id === sid);
    if (!node) continue;
    const data = node.data as BaseNodeData;
    const type = (data.type as string) || node.type || '';
    if (type === 'ai-director') {
      for (const url of collectDirectorImageUrls(data)) {
        addReference('image', url, sid, data);
      }
      continue;
    }
    if (
      type === 'ai-image'
      || type === 'source-image'
      || type === 'ai-panorama'
      || type === 'ai-storyboard'
    ) {
      addReference('image', data.imageUrl || data.thumbnailUrl, sid, data);
      continue;
    }
    addReference('video', data.videoUrl, sid, data);
    addReference('audio', data.audioUrl, sid, data);
  }
  return toLegacyReferenceMedia(mergeMediaReferences([], references));
}
