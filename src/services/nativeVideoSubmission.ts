/** 付费提交前冻结已保存画布基线；只返回不可逆摘要，不保存输入正文或媒体地址。 */
import type { Node, Edge } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import type { CanvasContext } from '../types/project';
import { useAppStore } from '../store/useAppStore';
import { isProjectExpectedContextCurrent } from './projectExecutionContext';
import { videoInputFingerprintMaterial } from './videoBatchPlanning';
import { readNativeProjectView } from './nativeProjectNavigation';
import { restoreProjectRecord } from './storageService';
import { verifyNativeVideoImageReference, type NativeVideoImageReference } from './nativeVideoImageReference';
import { sha256BytesHex } from './mediaDataUrl';
import { readNativeMediaMessageInput } from './nativeMediaOrigin';
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { nativeMediaInputMaterial } from './nativeMediaInput';

/** 仅由画布生成入口建立；直调和后台能力不能伪造旧画布的实时提交检查。 */
const nativeGuards = new WeakSet<() => void | Promise<void>>();
export function registerNativeVideoSubmissionGuard<T extends () => void | Promise<void>>(guard: T): T {
  nativeGuards.add(guard);
  return guard;
}
export function isNativeVideoSubmissionGuard(guard: (() => void | Promise<void>) | undefined): boolean {
  return !!guard && nativeGuards.has(guard);
}

export async function captureNativeVideoSubmissionBaseline(context: CanvasContext, nodeId: string, imageReference?: NativeVideoImageReference,
  scheme: NativeMediaTaskRecord['fingerprintScheme'] = 'video-input-v1'): Promise<{
  inputFingerprint: string; canvasRevision: number;
}> {
  const assertContext = () => {
    if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) {
      throw new Error('原画布已切换，未提交视频任务');
    }
  };
  assertContext();
  const message = readNativeMediaMessageInput(context.canvasId, nodeId);
  if (message) {
    if (imageReference) throw new Error('对话媒体不能借用画布参考素材');
    message.assertCurrent();
    if (await useAppStore.getState().saveCurrentProjectSilent() !== context.canvasId) throw new Error('原画布保存失败');
    const saved = await readNativeProjectView(context.projectId, context.canvasId);
    message.assertCurrent(); assertContext();
    if (!saved?.selection.canvas || saved.selection.project.epoch !== context.projectEpoch
      || saved.selection.canvas.epoch !== context.canvasEpoch || saved.selection.canvas.episodeId !== context.episodeId) throw new Error('原对话画布身份已变化');
    const inputFingerprint = await sha256BytesHex(new TextEncoder().encode(message.material));
    message.assertCurrent(); assertContext();
    return { inputFingerprint, canvasRevision: saved.selection.canvas.revision };
  }
  if (await useAppStore.getState().saveCurrentProjectSilent() !== context.canvasId) throw new Error('原画布未保存，未提交视频任务');
  assertContext();
  const initial = useAppStore.getState(), node = initial.nodes.find((item) => item.id === nodeId);
  const project = initial.projects.find((item) => item.id === context.canvasId);
  if (!node || !project) throw new Error('原视频节点不存在，未提交请求');
  const inputMaterial = scheme === 'media-input-v2' ? nativeMediaInputMaterial : videoInputFingerprintMaterial;
  const material = inputMaterial(node, initial);
  const settings = project.settings?.visualStyle;
  const styleId = settings?.locked ? settings.styleId : node.data.style || settings?.styleId;
  const links = initial.edges.filter((edge) => edge.target === nodeId);
  if ((imageReference ? links.length !== 1 || links[0].source !== imageReference.sourceNodeId : links.length !== 0) || material.includes('@{') || material.includes('@drama{')
    || node.data.videoReferences?.length || node.data.comfyRefmods?.length || settings?.styleReference && settings.styleReference.enabled !== false
    || styleId && initial.customStyles.some((style) => style.id === styleId)) {
    throw new Error('新项目仅支持无引用或单张项目自有原始图片连线；其他素材引用尚不能安全续查，未提交请求');
  }
  if (imageReference) await verifyNativeVideoImageReference(context, nodeId, imageReference);
  assertContext();
  const native = await readNativeProjectView(context.projectId, context.canvasId);
  assertContext();
  const canvas = native?.selection.canvas;
  if (!canvas || native.selection.project.epoch !== context.projectEpoch || canvas.epoch !== context.canvasEpoch
    || canvas.episodeId !== context.episodeId) throw new Error('保存的画布身份已变化，未提交请求');
  const restored = await restoreProjectRecord({ ...project, nodes: canvas.nodes, edges: canvas.edges, groups: canvas.groups,
    dramaAssets: native.content.dramaAssets });
  assertContext();
  const restoredNodes = restored.nodes as Node<BaseNodeData>[], restoredEdges = restored.edges as Edge[];
  const restoredNode = restoredNodes.find((item) => item.id === nodeId);
  const latest = useAppStore.getState(), latestNode = latest.nodes.find((item) => item.id === nodeId);
  if (!restoredNode || !latestNode || material !== inputMaterial(latestNode, latest)
    || material !== inputMaterial(restoredNode, { ...latest, nodes: restoredNodes, edges: restoredEdges })) {
    throw new Error('保存的节点或参考素材与当前输入不一致，未提交请求');
  }
  const inputFingerprint = await sha256BytesHex(new TextEncoder().encode(material));
  assertContext();
  const finalState = useAppStore.getState(), finalNode = finalState.nodes.find((item) => item.id === nodeId);
  if (!finalNode || material !== inputMaterial(finalNode, finalState)) throw new Error('媒体输入已变化，未提交请求');
  return { inputFingerprint, canvasRevision: canvas.revision };
}

/** Provider 的最后检查既覆盖真实节点，也覆盖仅在调用内存活的不可变对话输入。 */
export async function assertNativeVideoSubmissionInput(record: NativeMediaTaskRecord, context: CanvasContext): Promise<void> {
  const message = readNativeMediaMessageInput(context.canvasId, record.nodeId);
  if (record.origin?.deliveryMode === 'chat') {
    if (!message) throw new Error('原对话提交租约已结束，未提交请求');
    message.assertCurrent();
    const digest = await sha256BytesHex(new TextEncoder().encode(message.material));
    message.assertCurrent();
    if (digest !== record.inputFingerprint || !isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) throw new Error('原对话输入已变化');
    return;
  }
  const state = useAppStore.getState(), node = state.nodes.find((item) => item.id === record.nodeId);
  if (!node) throw new Error('原媒体节点不存在');
  const inputMaterial = record.fingerprintScheme === 'media-input-v2' ? nativeMediaInputMaterial : videoInputFingerprintMaterial;
  const material = inputMaterial(node, state);
  const digest = await sha256BytesHex(new TextEncoder().encode(material));
  const latest = useAppStore.getState(), next = latest.nodes.find((item) => item.id === record.nodeId);
  if (digest !== record.inputFingerprint || !next || material !== inputMaterial(next, latest)
    || !isProjectExpectedContextCurrent(context, latest, { checkCanvasRevision: false })) throw new Error('原媒体输入或画布已变化');
}
