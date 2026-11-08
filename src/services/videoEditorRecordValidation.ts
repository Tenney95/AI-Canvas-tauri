import type { VideoEditorProjectRecord } from '../types/videoEditor';
import { VIDEO_EDITOR_SCHEMA_VERSION } from '../types/videoEditor';
import { isTauriAssetUrl } from '../utils/mediaUrl';
import { safeExchangePath } from './projectExchangeDomain';

export function validateNativeVideoEditorRecord(record: VideoEditorProjectRecord, canvasId: string): void {
  if (!record || record.projectId !== canvasId || typeof record.nodeId !== 'string' || !record.nodeId
    || record.id !== `${canvasId}::${record.nodeId}` || record.id.length > 256
    || /[\u0000-\u001f\u007f-\u009f]/u.test(record.id)
    || !Number.isSafeInteger(record.schemaVersion) || record.schemaVersion < 0 || record.schemaVersion > VIDEO_EDITOR_SCHEMA_VERSION
    || typeof record.name !== 'string' || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)
    || !Array.isArray(record.tracks) || record.tracks.length > 100_000) throw new Error('剪辑工程身份或版本无效');
  for (const track of record.tracks) {
    if (!track || typeof track.id !== 'string' || typeof track.name !== 'string'
      || !['video', 'audio', 'caption'].includes(track.kind) || !Array.isArray(track.clips) || track.clips.length > 100_000) throw new Error('剪辑工程轨道无效');
    for (const clip of track.clips) {
      if (!clip || typeof clip.id !== 'string' || typeof clip.fileName !== 'string'
        || !['video', 'image', 'text'].includes(clip.kind) || !Number.isFinite(clip.timelineStart)
        || !Number.isFinite(clip.sourceIn) || !Number.isFinite(clip.sourceOut)) throw new Error('剪辑工程片段无效');
      const relative = clip.relativePath;
      if (clip.filePath !== undefined || relative !== undefined && (typeof relative !== 'string' || safeExchangePath(relative) !== relative)
        || typeof clip.sourceUrl === 'string' && (isTauriAssetUrl(clip.sourceUrl)
          || /^(?:\s*(?:data:|blob:|asset:|file:)|[a-z]:[\\/]|[\\/])/i.test(clip.sourceUrl))) {
        throw new Error('剪辑素材尚未转换为可持久化引用');
      }
    }
  }
}
