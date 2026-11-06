/**
 * assetImageDetails — 读取图片资产详情、生成历史与提示词引用。
 */
import { getLocale } from '../i18n';
import { findImageHistoryByReferences, getAssetCleanupTime, getNodeHistoryEntries, getProjectById, imageHistoryReferenceKey, type HistoryRecord } from './indexedDbService';
import { getFileCategory, type AssetFileEntry } from './fileService';
import type { AssetImageLoadedDetails, AssetImageReferenceView } from '../types/assetImage';
import { findSavedAssetImage, identifyAssetImage, resolveAssetImageReferences } from './fs/assetImageMetadata';
import { isTauriEnv } from './fs/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { parseDramaMentionId, type DramaAssetLibrary } from '../types/dramaAssets';
import { resolveDramaActionMediaRef, resolveDramaAssetImageRef } from './dramaAssetPrompt';
import { bestNodeThumb } from '../components/nodes/shared/mentionEditorDom';
import { ANIMATION_ACTION_LABELS, ANIMATION_FRAME_GRIDS, type AnimationAction } from '../types';
import { buildAnimationSpritePrompt, resolveAnimationSheetAspectRatio, type AnimationFrameCount } from './ai/animationPrompt';
import type { AnimationProcessing } from '../types/animation';

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function safeLocalAssetUrl(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  if (!IS_TAURI) return filePath;
  try {
    return convertFileSrc(filePath);
  } catch {
    return filePath;
  }
}

/** 旧记录没有保存拼接文本时按已有参数重建，只读展示并注明来源。 */
function completeAnimationPrompt(history: HistoryRecord): HistoryRecord {
  if (history.nodeType !== 'ai-animation' || history.params?.animationPromptVersion === 1) return history;
  const params = history.params ?? {};
  const frames = params.animationFrames;
  const action = params.animationAction;
  if (typeof frames !== 'number' || !Object.hasOwn(ANIMATION_FRAME_GRIDS, frames)
    || typeof action !== 'string' || !Object.hasOwn(ANIMATION_ACTION_LABELS, action)) return history;
  const processing = params.animationProcessing as Partial<AnimationProcessing> | undefined;
  const spriteProcessing = processing && ['auto', 'magenta', 'green', 'none'].includes(processing.chromaKey ?? '')
    && typeof processing.ground === 'boolean' && typeof processing.margin === 'number' && Number.isFinite(processing.margin)
    ? processing as Pick<AnimationProcessing, 'chromaKey' | 'ground' | 'margin'> : undefined;
  const aspectRatio = typeof params.aspectRatio === 'string' && params.aspectRatio
    ? params.aspectRatio : resolveAnimationSheetAspectRatio(frames as AnimationFrameCount, history.provider);
  return {
    ...history,
    prompt: buildAnimationSpritePrompt(history.prompt, action as AnimationAction, frames as AnimationFrameCount, aspectRatio, spriteProcessing),
    params: { ...params, assetPromptSource: params.assetPromptSource === 'canvas-node' ? 'animation-node' : 'animation-reconstructed' },
  };
}

/** 精确匹配图片与所属项目；历史缺失时只读找回生成节点，不按文件名猜测。 */
export async function loadAssetImageHistory(file: AssetFileEntry, projectId?: string, signal?: AbortSignal): Promise<HistoryRecord | null> {
  const references = [file.path, ...(file.assetUrl ? [file.assetUrl] : [])];
  const history = await findImageHistoryByReferences(references, projectId, signal);
  const cleanupTime = await getAssetCleanupTime(references, signal);
  if (history && (cleanupTime === undefined || history.timestamp > cleanupTime)) return completeAnimationPrompt(history);
  if (cleanupTime !== undefined || !projectId) return null;
  const checkAbort = () => { if (signal?.aborted) throw new DOMException('Preview closed', 'AbortError'); };
  checkAbort();
  const { useAppStore } = await import('../store/useAppStore');
  checkAbort();
  const state = useAppStore.getState();
  // 当前项目用实时节点；未打开的项目只读持久化画布，不切换项目或写回。
  const projectNodes = state.currentProjectId === projectId ? state.nodes : (await getProjectById(projectId))?.nodes;
  const nodes: unknown[] = Array.isArray(projectNodes) ? projectNodes : [];
  checkAbort();
  const keys = new Set(references.map(imageHistoryReferenceKey).filter(Boolean));
  const matches = nodes.filter((node): node is { id: string; data: Record<string, unknown> } => {
    if (!node || typeof node !== 'object' || !('id' in node) || typeof node.id !== 'string'
      || !('data' in node) || !node.data || typeof node.data !== 'object') return false;
    const data = node.data as Record<string, unknown>;
    if ((data.type !== 'ai-image' && data.type !== 'ai-animation') || data.role === 'source' || data.status !== 'success') return false;
    // filePath 是磁盘图片的权威引用；不以缩略图、输入参考图或同名文件关联。
    const reference = typeof data.filePath === 'string' && data.filePath ? data.filePath : data.imageUrl;
    const key = typeof reference === 'string' ? imageHistoryReferenceKey(reference) : undefined;
    return !!key && keys.has(key);
  });
  if (matches.length !== 1) return null;
  const { id, data } = matches[0];
  const originalReferences = [data.sourceUrl, data.output].filter((value): value is string => typeof value === 'string' && !!value);
  // 节点改名后仍保留原输出地址，可以用它找回原始提示词与参数。
  const original = originalReferences.length ? await findImageHistoryByReferences(originalReferences, projectId, signal) : null;
  checkAbort();
  // Cleanup may have committed while the project or original history was loading.
  if (await getAssetCleanupTime(references, signal) !== undefined) return null;
  checkAbort();
  if (original?.nodeId === id) return completeAnimationPrompt(original);
  if (typeof data.prompt !== 'string' || !data.prompt.trim()) return null;
  const sheet = data.animationSheet as { frameCount?: number; action?: string } | undefined;
  // 这只是节点现有内容的只读投影，不伪造生成时间，也不冒充原始生成记录。
  return completeAnimationPrompt({
    id: `canvas-node:${projectId}:${id}`, projectId, nodeId: id,
    nodeLabel: typeof data.label === 'string' ? data.label : file.name,
    timestamp: 0, prompt: data.prompt, output: typeof data.output === 'string' ? data.output : '',
    nodeType: data.type as string, model: '', provider: typeof data.provider === 'string' ? data.provider : '', status: 'success',
    filePath: file.path, mediaUrl: file.assetUrl, params: {
      assetPromptSource: 'canvas-node',
      ...(data.type === 'ai-animation' ? {
        animationFrames: sheet?.frameCount ?? data.animationFrames ?? 8,
        animationAction: sheet?.action ?? data.animationAction ?? 'idle',
        animationProcessing: data.animationProcessing,
        aspectRatio: data.aspectRatio,
      } : {}),
    },
  });
}

export async function loadAssetImageDetails(file: AssetFileEntry, projectId?: string, signal?: AbortSignal): Promise<AssetImageLoadedDetails & { history: HistoryRecord | null }> {
  const history = await loadAssetImageHistory(file, projectId, signal);
  if (!isTauriEnv()) return { identity: null, record: null, references: [], history, contentChanged: false, warning: '编辑和添加参考图仅支持桌面应用' };
  const identity = await identifyAssetImage(file, projectId, signal);
  const saved = await findSavedAssetImage(identity, signal);
  const references = saved.record ? await resolveAssetImageReferences(saved.record.references, signal) : [];
  return { identity, record: saved.record, references, contentChanged: saved.contentChanged,
    history: saved.contentChanged && !saved.record ? null : history,
    warning: saved.ambiguous ? '找到多个相同内容的信息记录，未自动关联' : saved.contentChanged && !saved.record ? '原图内容已变化，旧提示词与参考图仍保留' : null };
}

const IMAGE_PARAMETERS: ReadonlyArray<readonly [string, string]> = [
  ['imageSize', '生成尺寸'], ['aspectRatio', '宽高比'], ['resolution', '分辨率'],
  ['quality', '质量'], ['seed', '随机种子'], ['steps', '采样步数'],
  ['guidanceScale', '引导强度'], ['cfgScale', '提示词强度'], ['sampler', '采样器'],
  ['scheduler', '调度器'], ['negativePrompt', '反向提示词'],
];

/** 只展示已保存的参数白名单，不显示凭据、路径或任意嵌套对象。 */
export function describeAssetImageHistory(history: HistoryRecord): Array<{ label: string; value: string }> {
  const details: Array<{ label: string; value: string }> = [];
  if (history.params?.assetPromptSource === 'canvas-node') details.push({ label: '提示词来源', value: '画布节点当前内容' });
  if (history.params?.assetPromptSource === 'animation-node') details.push({ label: '提示词来源', value: '画布节点当前内容 + 动画规则重建' });
  if (history.params?.assetPromptSource === 'animation-reconstructed') details.push({ label: '提示词来源', value: '原提示词 + 现有动画规则重建（旧记录未保留完整文本）' });
  if (history.model) details.push({ label: '模型', value: history.model });
  if (history.provider) details.push({ label: '供应商', value: history.provider });
  for (const [key, label] of IMAGE_PARAMETERS) {
    const value = history.params?.[key];
    if (typeof value === 'string' && value.trim() || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') {
      details.push({ label, value: String(value) });
    }
  }
  if (Number.isFinite(history.timestamp) && history.timestamp > 0) {
    details.push({ label: '生成时间', value: new Date(history.timestamp).toLocaleString(getLocale()) });
  }
  return details;
}

/**
 * 从提示词文本中提取所有引用的图片（包括 @{nodeId:label}、@asset{path}、@drama{id:name}），
 * 供资产详情展示为参考图列表并支持全屏预览。
 */
export async function resolvePromptImageReferences(
  prompt: string,
  options?: {
    nodes?: Array<{ id: string; data?: Record<string, unknown> }>;
    dramaAssets?: DramaAssetLibrary;
    projectId?: string;
    signal?: AbortSignal;
  },
): Promise<AssetImageReferenceView[]> {
  if (!prompt || typeof prompt !== 'string') return [];
  const regex = /@asset\{([^}]+)\}|@drama\{([^:]+):([^}]+)\}|@\{([^:]+):([^}]+)\}/g;
  const references: AssetImageReferenceView[] = [];
  const seenUrls = new Set<string>();
  const appendReference = (id: string, name: string, url?: string) => {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    references.push({ id, name, relativePath: '', digest: '', bytes: 0, url });
  };
  const nodes = options?.nodes;
  const dramaAssets = options?.dramaAssets;
  const projectId = options?.projectId;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(prompt)) !== null) {
    if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (match[1] !== undefined) {
      let path = match[1];
      try { path = decodeURIComponent(match[1]); } catch { /* 保留原值 */ }
      const name = path.split(/[\\/]/).pop() || '参考图';
      if (getFileCategory(name) === 'image') {
        const url = safeLocalAssetUrl(path) || path;
        appendReference(`prompt-ref-asset:${path}`, name, url);
      }
    } else if (match[2] !== undefined) {
      const dramaId = match[2];
      const dramaName = match[3] || '资产参考';
      if (dramaAssets) {
        const { assetId, referenceImageId, actionId, actionMediaId } = parseDramaMentionId(dramaId);
        const found = dramaAssets.characters.find((a) => a.id === assetId)
          || dramaAssets.scenes.find((a) => a.id === assetId)
          || dramaAssets.props.find((a) => a.id === assetId);
        let url: string | undefined;
        let name = dramaName;

        if (actionId !== undefined) {
          const media = resolveDramaActionMediaRef(found, actionId, actionMediaId);
          if (media && media.kind !== 'video') {
            url = media.url;
            name = `${found?.name ?? ''} ${media.label || '动作'}`.trim();
          }
        } else if (found) {
          const picked = referenceImageId !== undefined
            ? found.referenceImages?.find((img) => img.id === referenceImageId)
            : undefined;
          if (referenceImageId !== undefined) {
            // 指定图片失效时保留缺失状态，不悄悄换成主图。
            const resolved = resolveDramaAssetImageRef(found, nodes ?? [], referenceImageId);
            url = resolved?.imageUrl;
            name = `${found.name} · ${picked && 'label' in picked ? picked.label || '参考图' : '参考图'}`;
          } else if (found.imageNodeId && nodes) {
            const node = nodes.find((n) => n.id === found.imageNodeId);
            url = bestNodeThumb(node?.data ?? {}) || (node?.data?.imageUrl as string | undefined) || found.imageUrl;
            name = found.name;
          } else {
            url = found.imageUrl;
            name = found.name;
          }
        }
        appendReference(`prompt-ref-drama:${dramaId}`, name, url);
      }
    } else if (match[4] !== undefined) {
      const nodeId = match[4];
      const label = match[5] || '生成图像';
      let url: string | undefined;
      let name = label;

      if (nodeId.includes('/cell/')) {
        const [parentId, , cellIdxStr] = nodeId.split('/');
        const cellIdx = Number.parseInt(cellIdxStr, 10);
        const parentNode = nodes?.find((n) => n.id === parentId);
        if (parentNode) {
          const overrides = (parentNode.data?.storyboardOverrides as Array<{ url?: string } | null> | undefined) ?? [];
          url = overrides[cellIdx]?.url || (parentNode.data?.imageUrl as string | undefined);
          name = `${parentNode.data?.label || '分镜'} 格${cellIdx + 1}`;
        }
      } else {
        const node = nodes?.find((n) => n.id === nodeId);
        if (node) {
          name = (node.data?.label as string) || label;
          url = bestNodeThumb(node.data ?? {})
            || (node.data?.imageUrl as string | undefined)
            || (node.data?.thumbnailUrl as string | undefined);
          if (!url && typeof node.data?.filePath === 'string' && node.data.filePath) {
            url = safeLocalAssetUrl(node.data.filePath);
          }
          if (!url && node.data?.type === 'ai-director' && Array.isArray(node.data.directorCaptureUrls)) {
            url = node.data.directorCaptureUrls.find((u) => typeof u === 'string' && u.trim());
          }
        } else if (projectId) {
          try {
            const entries = await getNodeHistoryEntries(projectId, nodeId);
            const mediaEntry = entries.find((e) => e.status === 'success' && (e.mediaUrl || e.filePath));
            if (mediaEntry) {
              url = mediaEntry.mediaUrl || (mediaEntry.filePath ? safeLocalAssetUrl(mediaEntry.filePath) : undefined);
              name = mediaEntry.nodeLabel || label;
            }
          } catch {
            // 忽略读取历史错误
          }
        }
      }
      appendReference(`prompt-ref-node:${nodeId}`, name, url);
    }
  }

  return references;
}

