/**
 * ai/promptResolver — @mention prompt 解析
 */
import { useAppStore } from '../../store/useAppStore';
import { readFileToDataUrl, getFileCategory } from '../fileService';
import { imageUrlReachable, resolveNodeImageUrl, mergeImageWithOverlays } from './imageUtils';
import { cropImageCell, cropImageByRanges } from '../../components/nodes/shared/image/imageUtils';
import { parseDramaMentionId } from '../../types/dramaAssets';
import {
  collectCharacterReferenceUrls,
  findDramaAsset,
  formatDramaAssetTextBrief,
  resolveDramaAssetImageRef,
  resolveDramaActionMediaRef,
} from '../dramaAssetPrompt';
import type { DramaAsset } from '../../types/dramaAssets';
import { formatShotRowBrief, isShotRowBlank, readShotFrameSource } from '../../types';
import type { BaseNodeData, ImageAnnotationLayer, ShotRow, StoryboardCellOverride } from '../../types';
import type { MediaReference } from '../../types/aiTypes';
import { mergeMediaReferences, toLegacyReferenceMedia } from './connectedReferenceMedia';

interface PromptImageEntry {
  url: string;
  mattingMask?: string;
  annotation?: string;
  annotationLayer?: ImageAnnotationLayer;
  filePath?: string;
  sourceNodeId?: string;
  sourceUrl?: string;
}

async function mergePromptImageOverlays(url: string, entry: PromptImageEntry): Promise<string> {
  let annotation = entry.annotation;
  const annotations = (entry.annotationLayer as { annotations?: unknown } | undefined)?.annotations;
  if (Array.isArray(annotations) && annotations.length > 0) {
    const runtime = await import('@tenney95/xiaoluo-image-editor');
    if (runtime.isImageAnnotationLayer(entry.annotationLayer)) {
      annotation = runtime.renderImageAnnotationLayerToDataUrl(entry.annotationLayer);
    }
  }
  if (!entry.mattingMask && !annotation) return url;
  return mergeImageWithOverlays(url, entry.mattingMask, annotation);
}

/** @drama{id#all} — 把角色的全部参考图拼成一张，失败（不足两张/加载不了）时返回 null 走单图路径 */
async function resolveMergedCharacterImage(
  asset: DramaAsset,
  nodes: Array<{ id: string; data?: Record<string, unknown> }>,
): Promise<string | null> {
  const urls = collectCharacterReferenceUrls(asset, nodes);
  if (urls.length < 2) return null;
  const resolved = (await Promise.all(urls.map((url) => resolveNodeImageUrl(url))))
    .filter((url): url is string => !!url);
  const { mergeReferenceImages } = await import('../characterReferenceMerge');
  return mergeReferenceImages(resolved);
}

/**
 * 解析宫格分镜虚拟 ID：从 {storyboardNodeId}/cell/{idx} 中提取真实 nodeId 和格下标。
 * 非分镜单元格引用直接返回原 nodeId。
 */
function parseStoryboardCellId(nodeId: string): { nodeId: string; cellIdx: number | null } {
  if (nodeId.includes('/cell/')) {
    const parts = nodeId.split('/cell/');
    const idx = parseInt(parts[1], 10);
    if (!isNaN(idx)) return { nodeId: parts[0], cellIdx: idx };
  }
  return { nodeId, cellIdx: null };
}

/** 从宫格分镜节点数据中提取第 cellIdx 格的真实裁片 dataUrl（含覆盖图直出）。 */
async function resolveStoryboardCellImage(
  sbData: BaseNodeData,
  cellIdx: number,
): Promise<string | null> {
  const cols = Math.max(1, (sbData.storyboardCols as number) || 3);
  const rows = Math.max(1, (sbData.storyboardRows as number) || 3);
  const total = rows * cols;
  if (cellIdx < 0 || cellIdx >= total) return null;

  const overrides = (sbData.storyboardOverrides as (StoryboardCellOverride | null)[] | undefined) ?? [];
  const imageUrl = sbData.imageUrl as string | undefined;

  // 覆盖图直接返回
  const override = overrides[cellIdx];
  if (override?.url) return override.url;

  if (!imageUrl) return null;

  const r = Math.floor(cellIdx / cols);
  const c = cellIdx % cols;
  const isCustomGrid = (sbData.storyboardRowPositions as number[] | undefined)?.length
    || (sbData.storyboardColPositions as number[] | undefined)?.length;

  try {
    if (isCustomGrid) {
      const rowPositions = (sbData.storyboardRowPositions as number[]) ?? [];
      const colPositions = (sbData.storyboardColPositions as number[]) ?? [];
      const hRanges = [0, ...rowPositions, 100];
      const vRanges = [0, ...colPositions, 100];
      const cell = await cropImageByRanges(imageUrl, hRanges, vRanges, r, c);
      return cell.dataUrl;
    }
    const cell = await cropImageCell(imageUrl, c, r, cols, rows);
    return cell.dataUrl;
  } catch (err) {
    console.error('[promptResolver] 分镜格裁切失败:', err);
    return imageUrl; // fallback to whole image
  }
}

/**
 * 分镜表引用：整表逐行拼成文字，每行绑定的画面顺带当参考图带上。
 *
 * 画面读的是画布上那个源节点的实时素材，源节点没了才用绑定时的快照兜底；
 * 视频画面取封面帧——参考图位置塞不进一整段视频。
 * addImage 由调用方给，负责去重和分配「图片N」的序号，行尾写上对应序号，
 * 模型才能把哪张图配哪一镜对上。
 */
export function resolveShotlistMention(
  shotlistData: BaseNodeData,
  nodes: Array<{ id: string; type?: string; data: BaseNodeData }>,
  addImage: (key: string, entry: PromptImageEntry) => number,
): string {
  const rows = (shotlistData.shotlistRows as ShotRow[] | undefined) ?? [];
  const lines: string[] = [];
  for (const row of rows) {
    if (isShotRowBlank(row)) continue;
    let line = formatShotRowBrief(row);
    const frame = row.frame;
    if (frame) {
      const source = nodes.find((node) => node.id === frame.nodeId);
      const url = (source ? readShotFrameSource(source).url : undefined) ?? frame.url;
      if (url?.trim()) {
        const idx = addImage(`node:${frame.nodeId}`, {
          url,
          filePath: (source?.data.filePath as string | undefined) ?? frame.filePath,
          sourceNodeId: frame.nodeId,
          sourceUrl: source?.data.sourceUrl as string | undefined,
        });
        line += `（图片${idx}）`;
      }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** 解析 prompt 中的 @{nodeId:label} 引用，返回适合 /chat/completions 的 content 字段
 *  - 仅含文本引用时返回纯字符串
 *  - 含图片引用时返回多模态数组 [{type:"text",text:...}, {type:"image_url",image_url:{url:...}}]
 *  同时返回纯文本版本 textContent，用于空值校验和系统提示拼接
 *  图片节点有蒙版/标注时自动合并到原图 */
export async function resolvePromptToChatContent(rawPrompt: string): Promise<{
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  textContent: string;
}> {
  const store = useAppStore.getState();
  const { nodes } = store;
  // groups: 1=@asset  2,3=@drama  4,5=@node
  const chipRegex = /@asset\{([^}]+)\}|@drama\{([^:]+):([^}]+)\}|@\{([^:]+):([^}]+)\}/g;
  const imageEntries: PromptImageEntry[] = [];
  const imageKeyToIndex = new Map<string, number>();
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = chipRegex.exec(rawPrompt)) !== null) {
    if (match.index > lastIndex) {
      parts.push(rawPrompt.slice(lastIndex, match.index));
    }

    if (match[1] !== undefined) {
      let assetPath = match[1];
      try { assetPath = decodeURIComponent(match[1]); } catch { /* keep raw */ }
      const assetName = assetPath.split(/[\\/]/).pop() || '';
      if (getFileCategory(assetName) === 'image') {
        const key = `asset:${match[1]}`;
        let idx = imageKeyToIndex.get(key);
        if (idx === undefined) {
          const dataUrl = await readFileToDataUrl(assetPath);
          if (dataUrl) {
            idx = imageEntries.length + 1;
            imageKeyToIndex.set(key, idx);
            imageEntries.push({ url: dataUrl });
          }
        }
        if (idx !== undefined) parts.push(`图片${idx}`);
      }
      lastIndex = chipRegex.lastIndex;
      continue;
    }

    // 短剧资产：有绑图且已出图 → 图片引用；否则 → 单条简介文本（首次生资产图的正常路径）
    if (match[2] !== undefined) {
      const dramaId = match[2];
      const dramaName = match[3] || '';
      const { assetId, referenceImageId, mergeAll, actionId, actionMediaId } = parseDramaMentionId(dramaId);
      const dramaAsset = findDramaAsset(store.dramaAssets, assetId);
      if (actionId !== undefined) {
        const media = resolveDramaActionMediaRef(dramaAsset, actionId, actionMediaId);
        if (!media) throw new Error(`动作素材引用已失效：${dramaName || '未命名动作'}`);
        if (media.kind === 'video') {
          // 文本模型沿用画布视频引用的 URL 文本语义。
          parts.push(`${media.label}（${media.url}）`);
        } else {
          const key = `drama:${dramaId}`;
          let idx = imageKeyToIndex.get(key);
          if (idx === undefined) {
            idx = imageEntries.length + 1;
            imageKeyToIndex.set(key, idx);
            imageEntries.push({ url: media.url, filePath: media.filePath });
          }
          parts.push(`图片${idx}（${media.label}）`);
        }
        lastIndex = chipRegex.lastIndex;
        continue;
      }
      const mergedUrl = dramaAsset && mergeAll
        ? await resolveMergedCharacterImage(
          dramaAsset,
          nodes as Array<{ id: string; data?: Record<string, unknown> }>,
        )
        : null;
      if (dramaAsset && mergedUrl) {
        const key = `drama:${dramaId}`;
        let idx = imageKeyToIndex.get(key);
        if (idx === undefined) {
          idx = imageEntries.length + 1;
          imageKeyToIndex.set(key, idx);
          imageEntries.push({ url: mergedUrl });
        }
        parts.push(`图片${idx}（${dramaAsset.name || dramaName} 全部参考图）`);
        lastIndex = chipRegex.lastIndex;
        continue;
      }
      if (dramaAsset) {
        const imgRef = resolveDramaAssetImageRef(
          dramaAsset,
          nodes as Array<{ id: string; data?: Record<string, unknown> }>,
          referenceImageId,
        );
        if (imgRef) {
          const imgNode = nodes.find((n) => n.id === imgRef.imageNodeId);
          const key = `drama:${dramaId}`;
          let idx = imageKeyToIndex.get(key);
          if (idx === undefined) {
            idx = imageEntries.length + 1;
            imageKeyToIndex.set(key, idx);
            imageEntries.push({
              url: imgRef.imageUrl,
              mattingMask: (imgNode?.data?.mattingMask as string | undefined) || undefined,
              annotation: (imgNode?.data?.annotation as string | undefined) || undefined,
              annotationLayer: imgNode?.data?.annotationLayer,
              filePath: (imgNode?.data?.filePath as string | undefined) || undefined,
            });
          }
          parts.push(`图片${idx}（${dramaAsset.name || dramaName}）`);
        } else {
          parts.push(formatDramaAssetTextBrief(dramaAsset));
        }
      } else {
        parts.push(dramaName || match[0]);
      }
      lastIndex = chipRegex.lastIndex;
      continue;
    }

    const rawNodeId = match[4];
    const { nodeId, cellIdx } = parseStoryboardCellId(rawNodeId);
    const node = nodes.find((n) => n.id === nodeId);

    // 宫格分镜单元格引用：裁切对应格图片
    if (cellIdx !== null && node && (node.data.type as string) === 'ai-storyboard') {
      const sbImage = await resolveStoryboardCellImage(node.data as BaseNodeData, cellIdx);
      if (sbImage) {
        const key = `sbcell:${rawNodeId}`;
        const idx = imageEntries.length + 1;
        imageKeyToIndex.set(key, idx);
        imageEntries.push({ url: sbImage });
        parts.push(`图片${idx}`);
      }
      lastIndex = chipRegex.lastIndex;
      continue;
    }

    if (!node) {
      parts.push(match[0]);
    } else {
      const nodeType = (node.data.type as string) || '';
      if (nodeType === 'ai-shotlist') {
        parts.push(resolveShotlistMention(node.data as BaseNodeData, nodes, (key, entry) => {
          let idx = imageKeyToIndex.get(key);
          if (idx === undefined) {
            idx = imageEntries.length + 1;
            imageKeyToIndex.set(key, idx);
            imageEntries.push(entry);
          }
          return idx;
        }));
        lastIndex = chipRegex.lastIndex;
        continue;
      }
      if (
        nodeType === 'ai-image'
        || nodeType === 'source-image'
        || nodeType === 'ai-storyboard'
        || nodeType === 'ai-director'
        || nodeType === 'ai-panorama'
      ) {
        const imageUrl = (
          (node.data.imageUrl as string | undefined)
          || (node.data.thumbnailUrl as string | undefined)
        );
        if (typeof imageUrl === 'string' && imageUrl.trim()) {
          const key = `node:${nodeId}`;
          let idx = imageKeyToIndex.get(key);
          if (idx === undefined) {
            idx = imageEntries.length + 1;
            imageKeyToIndex.set(key, idx);
            imageEntries.push({
              url: imageUrl,
              mattingMask: (node.data.mattingMask as string | undefined) || undefined,
              annotation: (node.data.annotation as string | undefined) || undefined,
              annotationLayer: node.data.annotationLayer,
              filePath: (node.data.filePath as string | undefined) || undefined,
            });
          }
          parts.push(`图片${idx}`);
        }
        if (nodeType === 'ai-director' && Array.isArray(node.data.directorCaptureUrls)) {
          for (const [i, url] of (node.data.directorCaptureUrls as string[]).entries()) {
            if (typeof url !== 'string' || !url.trim() || url === imageUrl) continue;
            const key = `node:${nodeId}:cap:${i}`;
            let idx = imageKeyToIndex.get(key);
            if (idx === undefined) {
              idx = imageEntries.length + 1;
              imageKeyToIndex.set(key, idx);
              imageEntries.push({ url });
            }
            parts.push(`图片${idx}`);
          }
        }
      } else {
        const output = node.data.output as string | undefined;
        if (typeof output === 'string' && output.trim()) {
          parts.push(output);
        } else {
          const videoUrl = node.data.videoUrl as string | undefined;
          if (typeof videoUrl === 'string' && videoUrl.trim()) {
            parts.push(videoUrl);
          } else {
            const audioUrl = node.data.audioUrl as string | undefined;
            if (typeof audioUrl === 'string' && audioUrl.trim()) {
              parts.push(audioUrl);
            }
          }
        }
      }
    }
    lastIndex = chipRegex.lastIndex;
  }

  if (lastIndex < rawPrompt.length) {
    parts.push(rawPrompt.slice(lastIndex));
  }

  const textContent = parts.join('').trim();

  if (imageEntries.length === 0) {
    return { content: textContent || rawPrompt.trim(), textContent: textContent || rawPrompt.trim() };
  }

  const imageUrls = await Promise.all(
    imageEntries.map(async (entry) => {
      const url = await resolveNodeImageUrl(entry.url, entry.filePath);
      try {
        return await mergePromptImageOverlays(url, entry);
      } catch (err) {
        console.error('[aiService] Failed to merge overlays:', err);
        return url;
      }
    }),
  );

  const contentArr: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  if (textContent) {
    contentArr.push({ type: 'text', text: textContent });
  }
  for (const url of imageUrls) {
    contentArr.push({ type: 'image_url', image_url: { url } });
  }

  return { content: contentArr, textContent: textContent || rawPrompt.trim() };
}

export interface PromptMediaReferences {
  prompt: string;
  references: MediaReference[];
  imageUrls: string[];
  videoUrls: string[];
  audioUrls: string[];
}

/** 收集提示词中直接 @ 的视频/音频节点产物，不改变提示词文本。 */
export function collectPromptNodeMediaUrls(
  rawPrompt: string,
): Pick<PromptMediaReferences, 'references' | 'videoUrls' | 'audioUrls'> {
  const { nodes } = useAppStore.getState();
  const references: MediaReference[] = [];

  for (const match of rawPrompt.matchAll(/@\{([^:]+):[^}]+\}/g)) {
    const rawNodeId = match[1];
    if (rawNodeId.includes('/cell/')) continue;
    const node = nodes.find((item) => item.id === rawNodeId);
    if (!node) continue;

    const videoUrl = typeof node.data.videoUrl === 'string' ? node.data.videoUrl.trim() : '';
    if (videoUrl) {
      references.push({
        kind: 'video',
        url: videoUrl,
        origin: 'prompt',
        role: 'reference',
        sourceNodeId: rawNodeId,
        filePath: node.data.filePath as string | undefined,
        sourceUrl: node.data.sourceUrl as string | undefined,
      });
    }

    const audioUrl = typeof node.data.audioUrl === 'string' ? node.data.audioUrl.trim() : '';
    if (audioUrl) {
      references.push({
        kind: 'audio',
        url: audioUrl,
        origin: 'prompt',
        role: 'reference_audio',
        sourceNodeId: rawNodeId,
        filePath: node.data.filePath as string | undefined,
        sourceUrl: node.data.sourceUrl as string | undefined,
      });
    }
  }

  const media = toLegacyReferenceMedia(mergeMediaReferences([], references));
  return {
    references: media.references,
    videoUrls: media.videoUrls,
    audioUrls: media.audioUrls,
  };
}

/** 解析 prompt 中的 @{nodeId:label} 引用，按需把视频/音频节点提取为独立媒体参数。 */
async function resolvePromptReferences(
  rawPrompt: string,
  extractMediaReferences: boolean,
): Promise<PromptMediaReferences> {
  const store = useAppStore.getState();
  const { nodes } = store;
  const imageEntries: PromptImageEntry[] = [];
  const mediaReferences: MediaReference[] = [];
  // groups: 1=@asset  2,3=@drama  4,5=@node
  const chipRegex = /@asset\{([^}]+)\}|@drama\{([^:]+):([^}]+)\}|@\{([^:]+):([^}]+)\}/g;

  const assetImageMap = new Map<string, string>();
  for (const m of rawPrompt.matchAll(/@asset\{([^}]+)\}/g)) {
    let p = m[1];
    try { p = decodeURIComponent(m[1]); } catch { /* keep raw */ }
    const name = p.split(/[\\/]/).pop() || '';
    if (getFileCategory(name) === 'image' && !assetImageMap.has(m[1])) {
      const dataUrl = await readFileToDataUrl(p);
      if (dataUrl) assetImageMap.set(m[1], dataUrl);
    }
  }

  // 预扫描宫格分镜单元格引用，提前裁切各格图片
  const sbCellImageMap = new Map<string, string>();
  for (const m of rawPrompt.matchAll(/@\{([^:]+):([^}]+)\}/g)) {
    const rawNodeId = m[1];
    if (rawNodeId.includes('/cell/')) {
      const { nodeId, cellIdx } = parseStoryboardCellId(rawNodeId);
      if (cellIdx !== null) {
        const sbNode = nodes.find((n) => n.id === nodeId);
        if (sbNode && (sbNode.data.type as string) === 'ai-storyboard') {
          const url = await resolveStoryboardCellImage(sbNode.data as BaseNodeData, cellIdx);
          if (url) sbCellImageMap.set(rawNodeId, url);
        }
      }
    }
  }

  // 下面是同步 replace，@drama{id#all} 的拼图得先异步做好
  const dramaMergedMap = new Map<string, string>();
  for (const m of rawPrompt.matchAll(/@drama\{([^:]+):([^}]+)\}/g)) {
    const { assetId, mergeAll } = parseDramaMentionId(m[1]);
    if (!mergeAll || dramaMergedMap.has(m[1])) continue;
    const asset = findDramaAsset(store.dramaAssets, assetId);
    if (!asset) continue;
    const merged = await resolveMergedCharacterImage(
      asset,
      nodes as Array<{ id: string; data?: Record<string, unknown> }>,
    );
    if (merged) dramaMergedMap.set(m[1], merged);
  }

  const imageKeyToIndex = new Map<string, number>();
  const videoKeyToIndex = new Map<string, number>();
  const audioKeyToIndex = new Map<string, number>();

  /** 登记一张参考图并返回它的「图片N」序号；同一张图重复引用只占一个位置 */
  const addImage = (key: string, entry: PromptImageEntry): number => {
    let idx = imageKeyToIndex.get(key);
    if (idx === undefined) {
      idx = imageEntries.length + 1;
      imageKeyToIndex.set(key, idx);
      imageEntries.push(entry);
    }
    return idx;
  };

  const prompt = rawPrompt.replace(
    chipRegex,
    (
      _match,
      assetEnc: string | undefined,
      dramaId: string | undefined,
      dramaName: string | undefined,
      rawNodeId: string | undefined,
    ) => {
    if (assetEnc !== undefined) {
      const dataUrl = assetImageMap.get(assetEnc);
      if (!dataUrl) return '';
      const key = `asset:${assetEnc}`;
      let idx = imageKeyToIndex.get(key);
      if (idx === undefined) {
        idx = imageEntries.length + 1;
        imageKeyToIndex.set(key, idx);
        imageEntries.push({ url: dataUrl });
      }
      return `图片${idx}`;
    }

    if (dramaId !== undefined) {
      const { assetId, referenceImageId, actionId, actionMediaId } = parseDramaMentionId(dramaId);
      if (actionId !== undefined) {
        const media = resolveDramaActionMediaRef(findDramaAsset(store.dramaAssets, assetId), actionId, actionMediaId);
        if (!media) throw new Error(`动作素材引用已失效：${dramaName || '未命名动作'}`);
        const key = `drama:${dramaId}`;
        if (media.kind !== 'video') {
          return `图片${addImage(key, { url: media.url, filePath: media.filePath })}`;
        }
        if (!extractMediaReferences) return media.url;
        let idx = videoKeyToIndex.get(key);
        if (idx === undefined) {
          idx = videoKeyToIndex.size + 1;
          videoKeyToIndex.set(key, idx);
          mediaReferences.push({ kind: 'video', url: media.url, filePath: media.filePath, origin: 'prompt', role: 'reference' });
        }
        return `视频${idx}`;
      }
      const mergedUrl = dramaMergedMap.get(dramaId);
      if (mergedUrl) {
        const key = `drama:${dramaId}`;
        let idx = imageKeyToIndex.get(key);
        if (idx === undefined) {
          idx = imageEntries.length + 1;
          imageKeyToIndex.set(key, idx);
          imageEntries.push({ url: mergedUrl });
        }
        return `图片${idx}`;
      }
      const dramaAsset = findDramaAsset(store.dramaAssets, assetId);
      if (dramaAsset) {
        const imgRef = resolveDramaAssetImageRef(
          dramaAsset,
          nodes as Array<{ id: string; data?: Record<string, unknown> }>,
          referenceImageId,
        );
        if (imgRef) {
          const imgNode = nodes.find((n) => n.id === imgRef.imageNodeId);
          const key = `drama:${dramaId}`;
          let idx = imageKeyToIndex.get(key);
          if (idx === undefined) {
            idx = imageEntries.length + 1;
            imageKeyToIndex.set(key, idx);
            imageEntries.push({
              url: imgRef.imageUrl,
              mattingMask: (imgNode?.data?.mattingMask as string | undefined) || undefined,
              annotation: (imgNode?.data?.annotation as string | undefined) || undefined,
              annotationLayer: imgNode?.data?.annotationLayer,
              filePath: (imgNode?.data?.filePath as string | undefined) || undefined,
              sourceNodeId: imgRef.imageNodeId,
              sourceUrl: (imgNode?.data?.sourceUrl as string | undefined) || undefined,
            });
          }
          return `图片${idx}`;
        }
        return formatDramaAssetTextBrief(dramaAsset);
      }
      return dramaName || '';
    }

    if (!rawNodeId) return '';

    // 宫格分镜单元格引用：使用预裁切好的图
    if (rawNodeId.includes('/cell/')) {
      const sbUrl = sbCellImageMap.get(rawNodeId);
      if (sbUrl) {
        const key = `sbcell:${rawNodeId}`;
        let idx = imageKeyToIndex.get(key);
        if (idx === undefined) {
          idx = imageEntries.length + 1;
          imageKeyToIndex.set(key, idx);
          imageEntries.push({ url: sbUrl, sourceNodeId: rawNodeId });
        }
        return `图片${idx}`;
      }
      return '';
    }
    const node = nodes.find((n) => n.id === rawNodeId);
    if (!node) return '';

    const nodeType = (node.data.type as string) || '';

    if (nodeType === 'ai-shotlist') {
      return resolveShotlistMention(node.data as BaseNodeData, nodes, addImage);
    }

    if (
      nodeType === 'ai-image'
      || nodeType === 'source-image'
      || nodeType === 'ai-storyboard'
      || nodeType === 'ai-director'
      || nodeType === 'ai-panorama'
      || nodeType === 'ai-animation'
    ) {
      const imageUrl = (
        (node.data.imageUrl as string | undefined)
        || (node.data.thumbnailUrl as string | undefined)
      );
      if (typeof imageUrl !== 'string' || !imageUrl.trim()) {
        if (nodeType === 'ai-director' && Array.isArray(node.data.directorCaptureUrls)) {
          const first = (node.data.directorCaptureUrls as string[]).find((u) => typeof u === 'string' && u.trim());
          if (first) {
            const key = `node:${rawNodeId}:cap0`;
            let idx = imageKeyToIndex.get(key);
            if (idx === undefined) {
              idx = imageEntries.length + 1;
              imageKeyToIndex.set(key, idx);
              imageEntries.push({ url: first, sourceNodeId: rawNodeId });
            }
            return `图片${idx}`;
          }
        }
        return '';
      }
      const key = `node:${rawNodeId}`;
      let idx = imageKeyToIndex.get(key);
      if (idx === undefined) {
        idx = imageEntries.length + 1;
        imageKeyToIndex.set(key, idx);
        imageEntries.push({
          url: imageUrl,
          mattingMask: (node.data.mattingMask as string | undefined) || undefined,
          annotation: (node.data.annotation as string | undefined) || undefined,
          annotationLayer: node.data.annotationLayer,
          filePath: (node.data.filePath as string | undefined) || undefined,
          sourceNodeId: rawNodeId,
          sourceUrl: (node.data.sourceUrl as string | undefined) || undefined,
        });
      }
      if (nodeType === 'ai-director' && Array.isArray(node.data.directorCaptureUrls)) {
        for (const [i, url] of (node.data.directorCaptureUrls as string[]).entries()) {
          if (typeof url !== 'string' || !url.trim() || url === imageUrl) continue;
          const capKey = `node:${rawNodeId}:cap:${i}`;
          if (!imageKeyToIndex.has(capKey)) {
            imageKeyToIndex.set(capKey, imageEntries.length + 1);
            imageEntries.push({ url, sourceNodeId: rawNodeId });
          }
        }
      }
      return `图片${idx}`;
    }

    if (nodeType === 'ai-text' || nodeType === 'source-text') {
      const output = node.data.output as string | undefined;
      if (typeof output === 'string' && output.trim()) return output;
      return '';
    }

    const videoUrl = node.data.videoUrl as string | undefined;
    if (typeof videoUrl === 'string' && videoUrl.trim()) {
      if (!extractMediaReferences) return videoUrl;
      let idx = videoKeyToIndex.get(rawNodeId);
      if (idx === undefined) {
        idx = videoKeyToIndex.size + 1;
        videoKeyToIndex.set(rawNodeId, idx);
        mediaReferences.push({
          kind: 'video',
          url: videoUrl.trim(),
          origin: 'prompt',
          role: 'reference',
          sourceNodeId: rawNodeId,
          filePath: node.data.filePath as string | undefined,
          sourceUrl: node.data.sourceUrl as string | undefined,
        });
      }
      return `视频${idx}`;
    }
    const audioUrl = node.data.audioUrl as string | undefined;
    if (typeof audioUrl === 'string' && audioUrl.trim()) {
      if (!extractMediaReferences) return audioUrl;
      let idx = audioKeyToIndex.get(rawNodeId);
      if (idx === undefined) {
        idx = audioKeyToIndex.size + 1;
        audioKeyToIndex.set(rawNodeId, idx);
        mediaReferences.push({
          kind: 'audio',
          url: audioUrl.trim(),
          origin: 'prompt',
          role: 'reference_audio',
          sourceNodeId: rawNodeId,
          filePath: node.data.filePath as string | undefined,
          sourceUrl: node.data.sourceUrl as string | undefined,
        });
      }
      return `音频${idx}`;
    }

    return '';
  }).trim();

  const imageReferences = await Promise.all(
    imageEntries.map(async (entry) => {
      const url = await resolveNodeImageUrl(entry.url, entry.filePath);
      let resolvedUrl = url;
      try {
        resolvedUrl = await mergePromptImageOverlays(url, entry);
      } catch (err) {
        console.error('[aiService] Failed to merge overlays:', err);
      }
      const hasOverlays = Boolean(entry.mattingMask || entry.annotation || entry.annotationLayer);
      const sourceUrl = !hasOverlays && entry.sourceUrl?.trim()
        ? entry.sourceUrl.trim()
        : undefined;
      const reachableSourceUrl = sourceUrl && (
        sourceUrl === entry.url
          ? url === sourceUrl
          : await imageUrlReachable(sourceUrl)
      )
        ? sourceUrl
        : undefined;
      return {
        kind: 'image',
        url: resolvedUrl,
        origin: 'prompt',
        role: 'reference',
        sourceNodeId: entry.sourceNodeId,
        filePath: entry.filePath,
        sourceUrl: reachableSourceUrl,
      } satisfies MediaReference;
    }),
  );

  const media = toLegacyReferenceMedia(mergeMediaReferences(imageReferences, mediaReferences));
  return {
    prompt,
    references: media.references,
    imageUrls: media.imageUrls,
    videoUrls: media.videoUrls,
    audioUrls: media.audioUrls,
  };
}

/** 图片生成兼容入口：图片 URL 独立提取，视频/音频仍按旧行为内联到 prompt。 */
export async function resolvePromptWithImageRefs(rawPrompt: string): Promise<{ prompt: string; imageUrls: string[] }> {
  const { prompt, imageUrls } = await resolvePromptReferences(rawPrompt, false);
  return { prompt, imageUrls };
}

/** 视频生成入口：图片、视频和音频引用都提取为对应的独立媒体参数。 */
export async function resolvePromptWithMediaRefs(rawPrompt: string): Promise<PromptMediaReferences> {
  return resolvePromptReferences(rawPrompt, true);
}
