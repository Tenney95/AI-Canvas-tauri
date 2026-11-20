/** APIMart 音乐内容保存在项目内；任务回执只引用带摘要的 JSON 文件。 */
import { invoke } from '@tauri-apps/api/core';
import type { AudioGenerationResult } from '../types/aiTypes';
import type { NativeAudioContentFile, NativeMediaLocalOutput, NativeMusicTrackMetadata } from '../types/media';
import { sha256BytesHex } from './mediaDataUrl';

export function validateNativeAudioContentFile(file: NativeAudioContentFile): void {
  if (!file || Object.keys(file).some((key) => !['relativePath', 'bytes', 'sha256', 'mimeType'].includes(key))
    || file.mimeType !== 'application/json' || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 256 * 1024
    || !/^[a-f0-9]{64}$/.test(file.sha256) || file.relativePath !== `media/${file.sha256}.json`) throw new Error('原音频内容文件身份无效');
}
export async function writeNativeAudioContent(projectId: string, value: unknown): Promise<NativeAudioContentFile> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (!bytes.length || bytes.length > 256 * 1024) throw new Error('原音频资料超过内容文件上限');
  const reference = await invoke<NativeAudioContentFile>('write_native_project_media', { projectId, mimeType: 'application/json', data: Array.from(bytes) });
  validateNativeAudioContentFile(reference);
  if (reference.bytes !== bytes.length || reference.sha256 !== await sha256BytesHex(bytes)) throw new Error('原音频资料未完整保存');
  await readNativeAudioContent(projectId, reference);
  return reference;
}
export async function readNativeAudioContent(projectId: string, reference: NativeAudioContentFile): Promise<unknown> {
  validateNativeAudioContentFile(reference);
  const bytes = new Uint8Array(await invoke<number[]>('read_native_project_media', { projectId, reference }));
  if (bytes.length !== reference.bytes || await sha256BytesHex(bytes) !== reference.sha256) throw new Error('原音频内容文件已变化');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
const boundedText = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit ? value : '';

export function musicTrackMetadata(track: AudioGenerationResult, submitted: { title?: string; lyrics?: string }): NativeMusicTrackMetadata {
  return {
    musicTitle: boundedText(track.title, 512) || submitted.title || '',
    musicLyrics: boundedText(track.lyrics, 30_000) || submitted.lyrics || '',
    musicClipId: boundedText(track.clipId, 256),
  };
}

export async function readMusicTrackMetadata(projectId: string, outputs?: NativeMediaLocalOutput[]): Promise<(NativeMusicTrackMetadata | undefined)[] | undefined> {
  if (!outputs?.some((output) => output.musicTrackFile)) return;
  const tracks: (NativeMusicTrackMetadata | undefined)[] = [];
  for (const output of outputs) {
    if (!output.musicTrackFile) { tracks.push(undefined); continue; }
    const row = await readNativeAudioContent(projectId, output.musicTrackFile) as NativeMusicTrackMetadata | null;
    if (!row || typeof row.musicTitle !== 'string' || row.musicTitle.length > 512
      || typeof row.musicLyrics !== 'string' || row.musicLyrics.length > 30_000
      || typeof row.musicClipId !== 'string' || row.musicClipId.length > 256
      || Object.keys(row).length !== 3) throw new Error('原音乐音轨资料无效');
    tracks.push(row);
  }
  return tracks;
}
