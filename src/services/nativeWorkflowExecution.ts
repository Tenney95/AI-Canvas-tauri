/** 工作流轻量分流与摘要；重提交和恢复模块只在执行动作时加载。 */
import { useAppStore } from '../store/useAppStore';
import { isNativeVideoSubmissionGuard } from './nativeVideoSubmissionGuard';
import { isCharacterImageTaskContext } from './characterImageTaskContext';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { sha256BytesHex } from './mediaDataUrl';

export const nativeWorkflowDigest = (value: unknown) => sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(value)));
export const isNativeWorkflowExecution = (guard?: () => void | Promise<void>) => isNativeVideoSubmissionGuard(guard)
  || isCharacterImageTaskContext(guard)
  || useAppStore.getState().projectExecutionContext?.modelGeneration === 1;
