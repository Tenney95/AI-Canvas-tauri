/** 节点编辑前置条件；完整输入仅参与本次摘要计算，不缓存或写入日志。 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import { sha256BytesHex } from '../mediaDataUrl';

const TEXT_OUTPUT_NODE_TYPES = new Set(['ai-text', 'ai-markdown', 'source-text', 'comment']);

/** 保持生成租约原有快照语义：状态、顶层产物和批次分组不参与。 */
export function generationInputSnapshot(data: BaseNodeData, projectSettings: unknown): string {
  return JSON.stringify([
    data.type, data.prompt, TEXT_OUTPUT_NODE_TYPES.has(data.type) ? data.output : undefined,
    data.model, data.provider, data.workflowId, data.workflowInputs, data.runninghubModelParameters,
    data.comfyRefmods, data.comfyH3MemoryPreset, data.imageSize, data.imageQuality, data.imageBackground,
    data.aspectRatio, data.batchCount, data.cameraSettings, data.videoResolution, data.videoFps, data.videoFrames,
    data.seedanceResolution, data.seedanceRatio, data.seedanceDuration, data.generateAudio, data.videoReferences,
    data.animationAction, data.animationFrames, data.animationProcessing, data.animationEdits,
    data.audioVoice, data.audioSpeechSettings, data.audioFormat, data.audioSpeed, data.audioPurpose,
    data.musicTitle, data.musicLyrics, data.musicBpm, data.musicDuration, data.autoGenerateLyrics, data.style,
    data.shotlistRows, data.shotlistColumns, data.shotlistCinematography,
    data.directorRuntimeKind, data.directorInstanceId, data.directorPrevisPrompt, data.directorPrevisModel,
    data.directorPrevisProvider, projectSettings,
  ]);
}

export async function getCanvasNodeHash(node: Node<BaseNodeData>, projectId: string, projectSettings?: unknown): Promise<string> {
  const data = node.data;
  // 编辑指纹保留镜头文字、顺序和绑定身份，不编码媒体快照或分析产物。
  const input = data.shotlistRows ? { ...data, shotlistRows: data.shotlistRows.map((row) => ({
    id: row.id, shotNo: row.shotNo, shotSize: row.shotSize, camera: row.camera, cinematography: row.cinematography,
    content: row.content, dialogue: row.dialogue, audio: row.audio, transition: row.transition, duration: row.duration, note: row.note,
    frame: row.frame ? { nodeId: row.frame.nodeId, kind: row.frame.kind, sourceDuration: row.frame.sourceDuration } : row.frame,
    video: row.video ? { nodeId: row.video.nodeId, kind: row.video.kind, sourceDuration: row.video.sourceDuration } : row.video,
  })) } : data;
  const identity = JSON.stringify([
    projectId, node.id, node.type, node.parentId, data.label, data.displayLabel, data.fileName,
    data.nodeWidth, data.nodeHeight, node.position.x, node.position.y,
  ]);
  const snapshot = `${identity}\n${generationInputSnapshot(input, projectSettings)}`;
  return sha256BytesHex(new TextEncoder().encode(snapshot));
}

/** 摘要等待期间的调用级快照守卫，不依赖 UI 是否显式递增 revision。 */
export function matchesCanvasNodeSnapshot(snapshot: Node<BaseNodeData>, current: Node<BaseNodeData> | undefined): boolean {
  return !!current && current.id === snapshot.id && current.type === snapshot.type && current.parentId === snapshot.parentId
    && current.data === snapshot.data && current.position.x === snapshot.position.x && current.position.y === snapshot.position.y;
}
