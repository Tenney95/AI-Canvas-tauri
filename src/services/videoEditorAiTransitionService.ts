/**
 * AI 转场 — 主窗口侧执行
 *
 * 剪辑窗口是独立 webview：它有自己的模块实例，读不到主窗口的 Store，
 * 也拿不到 API Key。因此转场的模型调用一律在主窗口完成，
 * 编辑器只负责出首/尾帧、给提示词，并接收落盘后的结果。
 */
import { useAppStore } from '../store/useAppStore';
import { getMediaModelOptions } from '../components/nodes/shared/defaultModels';
import { generateVideo } from './ai/generateVideo';
import { downloadUrlAndSave, saveBinaryToProjectData } from './fileService';
import type { MediaReference } from '../types/aiTypes';
import type {
  VideoEditorAiTransitionRequest,
  VideoEditorModelOption,
} from './videoEditorWindowService';

/** 编辑器模型下拉的数据源：与画布视频节点用同一份模型目录 */
export function listVideoEditorVideoModels(): VideoEditorModelOption[] {
  const config = useAppStore.getState().config;
  return getMediaModelOptions(config.generalModels ?? [], config)
    .filter((option) => option.mediaKind === 'video')
    .map((option) => ({
      value: option.value,
      label: option.label,
      provider: option.provider,
      groupName: option.groupName,
    }));
}

export interface VideoEditorAiTransitionOutcome {
  videoUrl: string;
  filePath?: string;
  fileName: string;
}

/** 首/尾帧转成生成入口认识的参考媒体；顺序即角色顺序 */
function buildFrameReferences(request: VideoEditorAiTransitionRequest): MediaReference[] {
  const frames: Array<{ url: string; filePath?: string }> = [
    { url: request.firstFrameUrl, filePath: request.firstFrameFilePath },
    { url: request.lastFrameUrl, filePath: request.lastFrameFilePath },
  ];
  return frames
    .filter((frame) => !!frame.url.trim())
    .map((frame, index) => ({
      kind: 'image' as const,
      url: frame.url,
      origin: 'connection' as const,
      role: index === 0 ? ('first_frame' as const) : ('last_frame' as const),
      filePath: frame.filePath,
    }));
}

/**
 * 按首帧 → 尾帧生成一段过渡视频，并写入项目数据目录。
 *
 * 落盘失败不静默降级：编辑器需要一个稳定可读的地址来建片段，
 * 只有远端签名 URL 的话，工程下次打开就取不到素材了。
 */
export async function runVideoEditorAiTransition(
  request: VideoEditorAiTransitionRequest,
  projectId: string,
  signal?: AbortSignal,
): Promise<VideoEditorAiTransitionOutcome> {
  const prompt = request.prompt.trim();
  if (!prompt) throw new Error('转场提示词不能为空');
  if (!request.model || !request.provider) throw new Error('请先选择用于生成转场的视频模型');

  const references = buildFrameReferences(request);
  if (references.length < 2) throw new Error('缺少首帧或尾帧，无法生成转场');

  const projectSettings = useAppStore.getState().projects
    .find((project) => project.id === projectId)?.settings;
  const directGeneralProtocol = request.provider === 'general';

  const result = await generateVideo({
    prompt,
    model: request.model,
    provider: request.provider,
    referenceMedia: references,
    seedanceRatio: directGeneralProtocol ? undefined : projectSettings?.generation?.videoAspectRatio,
    seedanceResolution: directGeneralProtocol ? undefined : projectSettings?.generation?.videoResolution,
    seedanceDuration: request.duration
      ?? (directGeneralProtocol ? undefined : projectSettings?.generation?.videoDuration),
  }, signal);

  const baseName = `AI转场-${Date.now().toString(36)}`;
  const saved = result.url.startsWith('blob:')
    ? await saveBinaryToProjectData(
      new Uint8Array(await (await fetch(result.url)).arrayBuffer()),
      projectId,
      `${baseName}.mp4`,
    )
    : await downloadUrlAndSave(result.url, projectId, 'ai-video', baseName);

  if (!saved?.filePath) throw new Error('转场已生成，但写入项目目录失败');

  return {
    videoUrl: saved.assetUrl || result.url,
    filePath: saved.filePath,
    fileName: `${baseName}.mp4`,
  };
}
