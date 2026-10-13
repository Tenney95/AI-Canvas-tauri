/** GRSAI H3 复用声明式提交、轮询与恢复；生成提交不重试。 */
import { GRSAI_BASE_URL } from '../../../constants/api';
import { useAppStore } from '../../../store/useAppStore';
import { captureVideoTaskGeneration, cleanupNodePolling, pauseVideoNodeTaskOnTimeout, registerNodePolling, removePendingTask, savePendingTask } from '../../pollManager';
import { resolveMediaReferenceUrl } from '../../uploadService';
import { getMediaReferenceUrl } from '../connectedReferenceMedia';
import { getGrsaiVideoCapability, GRSAI_H3_PROTOCOL } from '../grsaiModels';
import { extractModelName } from '../helpers';
import { resolveImageUrlArray } from '../imageUtils';
import { pollResolvedModelProtocol, submitModelProtocol } from '../modelProtocol';
import type { MediaProviderAdapter } from '../mediaProviderRegistry';

export const grsaiMediaProviderAdapter: MediaProviderAdapter = {
  providerId: 'grsai', capabilities: ['video'],
  async generateVideo({ params, resolveReferenceInput, signal: externalSignal }) {
    const provider = useAppStore.getState().config.providers.grsai;
    if (!provider?.apiKey) throw new Error('请先配置 GRSAI 的 API Key');
    const baseUrl = provider.baseUrl?.trim() || GRSAI_BASE_URL;
    const model = extractModelName(params.model, params.provider);
    const capability = getGrsaiVideoCapability(model, params.seedanceResolution);
    if (!capability) throw new Error(`GRSAI 未适配视频模型 ${model}`);
    const input = await resolveReferenceInput();
    if (!input.prompt.trim()) throw new Error('提示词不能为空');
    if (input.videoUrls.length || input.operation === 'video-to-video') throw new Error('GRSAI H3 不支持参考视频');
    if (input.references?.some((ref) => ref.role === 'first_frame' || ref.role === 'last_frame')) {
      throw new Error('GRSAI H3 不支持专用首尾帧，请将图片设为普通参考图');
    }
    if (input.imageUrls.length > 9 || input.audioUrls.length > 3) throw new Error('GRSAI H3 最多支持 9 张参考图和 3 段参考音频');
    const resolution = params.seedanceResolution?.toLowerCase() ?? capability.defaultResolution!;
    if (!capability.resolutions!.includes(resolution)) throw new Error('GRSAI H3 分辨率仅支持 480p / 768p / 1080p');
    const ratio = params.seedanceRatio ?? capability.defaultRatio;
    if (!capability.ratios!.includes(ratio!)) throw new Error('GRSAI H3 比例仅支持 16:9 / 9:16');
    const duration = params.seedanceDuration ?? capability.defaultDuration!;
    if (!Number.isInteger(duration) || duration < 1 || duration > capability.maxDuration!) {
      throw new Error(`GRSAI H3 ${resolution} 时长仅支持 1–${capability.maxDuration} 秒`);
    }
    const nodeSignal = params.nodeId ? registerNodePolling(params.nodeId) : undefined;
    const projectId = useAppStore.getState().currentProjectId;
    const videoGeneration = captureVideoTaskGeneration(params.nodeId);
    let submittedTaskId: string | undefined;
    let keepPending = false;
    const signal = nodeSignal && externalSignal ? AbortSignal.any([nodeSignal, externalSignal]) : nodeSignal ?? externalSignal;
    try {
      signal?.throwIfAborted();
      const imageReferences = input.references?.filter((ref) => ref.kind === 'image');
      const audioReferences = input.references?.filter((ref) => ref.kind === 'audio');
      const images = imageReferences?.length ? imageReferences.map(getMediaReferenceUrl) : input.imageUrls;
      const audios = audioReferences?.length ? audioReferences.map(getMediaReferenceUrl) : input.audioUrls;
      const imageUrls = await resolveImageUrlArray(images, 'grsai', signal);
      const audioUrls: string[] = [];
      for (const url of audios) audioUrls.push(await resolveMediaReferenceUrl(url, { provider: 'grsai', kind: 'audio', signal }));
      signal?.throwIfAborted();
      const submitted = await submitModelProtocol({ apiKey: provider.apiKey, baseUrl, protocol: GRSAI_H3_PROTOCOL, signal,
        variables: { model, prompt: input.prompt, resolution, duration, aspectRatio: ratio === '9:16' ? 'portrait' : 'landscape', imageUrls, audioUrls },
        validateResponse: (payload) => {
          const result = payload as { status?: string; error?: string } | null;
          if (result?.status === 'failed' || result?.status === 'violation') throw new Error(result.error || 'GRSAI H3 提交失败');
        },
      });
      if (!submitted.taskId || !submitted.poll) throw new Error('GRSAI H3 未返回任务 ID');
      submittedTaskId = submitted.taskId;
      if (params.nodeId && projectId) savePendingTask({ nodeId: params.nodeId, projectId, nodeType: 'ai-video',
        provider: 'grsai', providerConfigId: 'grsai', taskId: submitted.taskId, taskType: 'custom-protocol',
        protocolPoll: submitted.poll, videoGeneration, submitted: true });
      const result = await pollResolvedModelProtocol(submitted.poll, provider.apiKey, signal, baseUrl);
      const url = result.urls?.[0];
      if (!url) throw new Error('GRSAI H3 完成但没有返回视频');
      keepPending = true;
      return { url };
    } catch (error) {
      const paused = pauseVideoNodeTaskOnTimeout(params.nodeId, error, submittedTaskId);
      if (paused) { keepPending = true; throw paused; }
      throw error;
    } finally {
      if (params.nodeId && cleanupNodePolling(params.nodeId, nodeSignal) && !keepPending) removePendingTask(params.nodeId, submittedTaskId);
    }
  },
};
