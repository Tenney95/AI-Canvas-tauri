import { VideoEditorControlError } from "../types/videoEditorControl";
/** 主窗口导出与验片共用的有界素材生命周期。 */
import type { Input } from 'mediabunny';
import type { VideoEditorProjectRecord } from '../types/videoEditor';
import { createVideoInput, probeVideoSource } from './videoEditorMediaService';
import { createClipRenderSource, type ClipRenderSource } from './videoCompositor';
import { createBudgetedRenderBitmap } from './videoEditorRenderBitmap';
import { controlledClipUrl } from './videoEditorInspectionService';
import { bindVideoEditorMedia, DEFAULT_VIDEO_EDITOR_OUTPUT } from './videoEditorControlService';

export function assertControlledSourcesFresh(record: VideoEditorProjectRecord): void {
  for (const track of record.tracks) for (const clip of track.clips) {
    if (clip.kind === 'text') continue;
    if (!clip.nodeId) throw new VideoEditorControlError('素材没有绑定画布节点，请重新建立时间轴');
    const bound = bindVideoEditorMedia(clip.nodeId, clip.kind, track.kind === 'audio');
    if (bound.filePath !== clip.filePath || bound.sourceUrl !== clip.sourceUrl || bound.assetId !== clip.assetId) {
      throw new VideoEditorControlError('时间轴素材已变化，请重新提交轨道绑定后导出');
    }
  }
}

export async function prepareControlledRenderSources(record: VideoEditorProjectRecord, check: () => void) {
  const inputs = new Map<string, Input>();
  const renders = new Map<string, ClipRenderSource>();
  const clipInputs = new Map<string, Input>();
  const clipRenders = new Map<string, ClipRenderSource>();
  const dispose = () => {
    for (const input of inputs.values()) input.dispose();
    for (const source of renders.values()) source.bitmap?.close();
    inputs.clear(); renders.clear(); clipInputs.clear(); clipRenders.clear();
  };
  let retainedBytes = 0;
  try {
    for (const track of record.tracks) for (const clip of track.clips) {
      check();
      if (clip.kind === 'text') continue;
      if (!clip.nodeId) throw new VideoEditorControlError('素材没有绑定画布节点，请重新建立时间轴');
      const bound = bindVideoEditorMedia(clip.nodeId, clip.kind, track.kind === 'audio');
      if (bound.filePath !== clip.filePath || bound.sourceUrl !== clip.sourceUrl || bound.assetId !== clip.assetId) {
        throw new VideoEditorControlError('时间轴素材已变化，请重新提交轨道绑定后导出');
      }
      const url = controlledClipUrl(bound);
      if (clip.kind === 'image') {
        if (!renders.has(url)) {
          const { bitmap, bytes } = await createBudgetedRenderBitmap(url, retainedBytes, record.output ?? DEFAULT_VIDEO_EDITOR_OUTPUT);
          renders.set(url, { bitmap, width: bitmap.width, height: bitmap.height });
          retainedBytes += bytes;
        }
        clipRenders.set(clip.id, renders.get(url)!);
      } else {
        if (!inputs.has(url)) inputs.set(url, await createVideoInput(url));
        const input = inputs.get(url)!;
        const probe = await probeVideoSource(input);
        if (!Number.isFinite(probe.duration) || clip.sourceOut > probe.duration + 0.02) throw new VideoEditorControlError('片段出点超过素材真实时长');
        if (track.kind === 'audio') {
          const audio = await input.getPrimaryAudioTrack();
          if (!audio || !await audio.canDecode()) throw new VideoEditorControlError('音频素材无法解码');
        } else if (!renders.has(url)) {
          const render = await createClipRenderSource(input);
          if (!render) throw new VideoEditorControlError('视频素材无法解码');
          renders.set(url, render);
        }
        clipInputs.set(clip.id, input);
        if (track.kind === 'video') clipRenders.set(clip.id, renders.get(url)!);
      }
      check();
    }
    return { assertFresh: () => assertControlledSourcesFresh(record), resolveVideo: (clip: { id: string }) => clipRenders.get(clip.id),
      resolveAudio: (clip: { id: string }) => clipInputs.get(clip.id), dispose };
  } catch (error) { dispose(); throw error; }
}
