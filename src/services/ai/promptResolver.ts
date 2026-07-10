/**
 * ai/promptResolver — @mention prompt 解析
 */
import { useAppStore } from '../../store/useAppStore';
import { readFileToDataUrl, getFileCategory } from '../fileService';
import { resolveNodeImageUrl, mergeImageWithOverlays } from './imageUtils';

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

    const nodeId = match[2];
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) {
      parts.push(match[0]);
    } else {
      const nodeType = (node.data.type as string) || '';
      if (nodeType === 'ai-image' || nodeType === 'source-image') {
        const imageUrl = node.data.imageUrl as string | undefined;
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

  const imageKeyToIndex = new Map<string, number>();

  const chipRegex = /@asset\{([^}]+)\}|@\{([^:]+):([^}]+)\}/g;
  const prompt = rawPrompt.replace(chipRegex, (_match, assetEnc: string | undefined, nodeId: string) => {
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
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return '';

    const nodeType = (node.data.type as string) || '';

    if (nodeType === 'ai-image' || nodeType === 'source-image') {
      const imageUrl = node.data.imageUrl as string | undefined;
      if (typeof imageUrl !== 'string' || !imageUrl.trim()) return '';
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
