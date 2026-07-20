/**
 * ai/promptResolver — @mention prompt 解析
 */
import { useAppStore } from '../../store/useAppStore';
import { readFileToDataUrl, getFileCategory } from '../fileService';
import { resolveNodeImageUrl, mergeImageWithOverlays } from './imageUtils';
import { cropImageCell, cropImageByRanges } from '../../components/nodes/shared/image/imageUtils';
import type { BaseNodeData, StoryboardCellOverride } from '../../types';

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

/** 解析 prompt 中的 @{nodeId:label} 引用，返回适合 /chat/completions 的 content 字段
 *  - 仅含文本引用时返回纯字符串
 *  - 含图片引用时返回多模态数组 [{type:"text",text:...}, {type:"image_url",image_url:{url:...}}]
 *  同时返回纯文本版本 textContent，用于空值校验和系统提示拼接
 *  图片节点有蒙版/标注时自动合并到原图 */
export async function resolvePromptToChatContent(rawPrompt: string): Promise<{
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  textContent: string;
}> {
  const { nodes } = useAppStore.getState();
  const chipRegex = /@asset\{([^}]+)\}|@\{([^:]+):([^}]+)\}/g;
  const imageEntries: Array<{ url: string; mattingMask?: string; annotation?: string; filePath?: string }> = [];
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

    const rawNodeId = match[2];
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
      if (!entry.mattingMask && !entry.annotation) return url;
      try {
        return await mergeImageWithOverlays(url, entry.mattingMask, entry.annotation);
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

/** 解析 prompt 中的 @{nodeId:label} 引用：图片节点 URL 提取到 image_urls，文本/视频/音频节点内联替换到 prompt
 *  图片节点有蒙版/标注时自动合并到原图 */
export async function resolvePromptWithImageRefs(rawPrompt: string): Promise<{ prompt: string; imageUrls: string[] }> {
  const { nodes } = useAppStore.getState();
  const imageEntries: Array<{ url: string; mattingMask?: string; annotation?: string; filePath?: string }> = [];
  const chipRegex = /@asset\{([^}]+)\}|@\{([^:]+):([^}]+)\}/g;

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

  const imageKeyToIndex = new Map<string, number>();

  const prompt = rawPrompt.replace(chipRegex, (_match, assetEnc: string | undefined, rawNodeId: string) => {
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

    // 宫格分镜单元格引用：使用预裁切好的图
    if (rawNodeId.includes('/cell/')) {
      const sbUrl = sbCellImageMap.get(rawNodeId);
      if (sbUrl) {
        const key = `sbcell:${rawNodeId}`;
        let idx = imageKeyToIndex.get(key);
        if (idx === undefined) {
          idx = imageEntries.length + 1;
          imageKeyToIndex.set(key, idx);
          imageEntries.push({ url: sbUrl });
        }
        return `图片${idx}`;
      }
      return '';
    }
    const node = nodes.find((n) => n.id === rawNodeId);
    if (!node) return '';

    const nodeType = (node.data.type as string) || '';

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
      if (typeof imageUrl !== 'string' || !imageUrl.trim()) {
        if (nodeType === 'ai-director' && Array.isArray(node.data.directorCaptureUrls)) {
          const first = (node.data.directorCaptureUrls as string[]).find((u) => typeof u === 'string' && u.trim());
          if (first) {
            const key = `node:${rawNodeId}:cap0`;
            let idx = imageKeyToIndex.get(key);
            if (idx === undefined) {
              idx = imageEntries.length + 1;
              imageKeyToIndex.set(key, idx);
              imageEntries.push({ url: first });
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
          filePath: (node.data.filePath as string | undefined) || undefined,
        });
      }
      if (nodeType === 'ai-director' && Array.isArray(node.data.directorCaptureUrls)) {
        for (const [i, url] of (node.data.directorCaptureUrls as string[]).entries()) {
          if (typeof url !== 'string' || !url.trim() || url === imageUrl) continue;
          const capKey = `node:${rawNodeId}:cap:${i}`;
          if (!imageKeyToIndex.has(capKey)) {
            imageKeyToIndex.set(capKey, imageEntries.length + 1);
            imageEntries.push({ url });
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
    if (typeof videoUrl === 'string' && videoUrl.trim()) return videoUrl;
    const audioUrl = node.data.audioUrl as string | undefined;
    if (typeof audioUrl === 'string' && audioUrl.trim()) return audioUrl;

    return '';
  }).trim();

  const imageUrls = await Promise.all(
    imageEntries.map(async (entry) => {
      const url = await resolveNodeImageUrl(entry.url, entry.filePath);
      if (!entry.mattingMask && !entry.annotation) return url;
      try {
        return await mergeImageWithOverlays(url, entry.mattingMask, entry.annotation);
      } catch (err) {
        console.error('[aiService] Failed to merge overlays:', err);
        return url;
      }
    }),
  );

  return { prompt, imageUrls };
}
