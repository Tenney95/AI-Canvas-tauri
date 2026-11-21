import { useCallback } from 'react';
import { removeAudioSpeechReference } from '../../services/ai/audioSpeechSettings';
import { getImageNodeDimensionsForAspectRatio } from '../../services/projectSettingsService';
import { useAppStore, type AppState } from '../../store/useAppStore';
import type { AnimationAction, BaseNodeData, CameraGenerationSettings } from '../../types';
import type {
  AudioOutputFormat, AudioSpeechReference, AudioSpeechSettings, AudioTtsVoice, ImageOutputParameters, VideoReferenceItem,
} from '../../types/aiTypes';

export function useNodeModelParameterActions({
  activeNodeId, nodeType, updateNodeData, updateContinuousNodeData, finishContinuousEdit,
}: {
  activeNodeId: AppState['activeNodeId'];
  nodeType: BaseNodeData['type'] | undefined;
  updateNodeData: AppState['updateNodeData'];
  updateContinuousNodeData: (patch: Partial<BaseNodeData>) => void;
  finishContinuousEdit: () => void;
}) {
  const onChangeImageSize = useCallback(
    (value: string) => updateNodeData(activeNodeId!, { imageSize: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeImageQuality = useCallback(
    (value: string | undefined) => updateNodeData(activeNodeId!, { imageQuality: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeImageBackground = useCallback(
    (value: string | undefined) => updateNodeData(activeNodeId!, { imageBackground: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeImageOutputParameters = useCallback(
    (parameters: ImageOutputParameters) => updateNodeData(activeNodeId!, { ...parameters }),
    [activeNodeId, updateNodeData]
  );

  const onChangeAspectRatio = useCallback(
    (value: string) => {
      const updateData: Partial<BaseNodeData> = { aspectRatio: value };
      const dimensions = getImageNodeDimensionsForAspectRatio(value);
      if (dimensions) Object.assign(updateData, dimensions);

      updateNodeData(activeNodeId!, updateData);
    },
    [activeNodeId, updateNodeData]
  );

  const onWorkflowInputsChange = useCallback((workflowInputs: Record<string, string>, aspectRatio?: string) => {
    const patch: Partial<BaseNodeData> = { workflowInputs };
    if (aspectRatio && (nodeType === 'ai-image' || nodeType === 'ai-panorama')) {
      Object.assign(patch, { aspectRatio }, getImageNodeDimensionsForAspectRatio(aspectRatio) ?? {});
    } else if (aspectRatio && nodeType === 'ai-video') {
      // Store 沿用空视频框的比例联动，已有成片继续保留真实尺寸。
      Object.assign(patch, { aspectRatio, seedanceRatio: aspectRatio });
    }
    updateContinuousNodeData(patch);
  }, [nodeType, updateContinuousNodeData]);

  const onChangeBatchCount = useCallback(
    (value: number) => updateNodeData(activeNodeId!, { batchCount: value }),
    [activeNodeId, updateNodeData],
  );

  const onChangeCameraSettings = useCallback(
    (value: CameraGenerationSettings | undefined) => updateNodeData(activeNodeId!, { cameraSettings: value }),
    [activeNodeId, updateNodeData],
  );

  const onChangeVideoResolution = useCallback(
    // 自定义长边是逐字输入的，走连续编辑，别把每个键都记成一步撤销
    (value: number) => updateContinuousNodeData({ videoResolution: value }),
    [updateContinuousNodeData]
  );

  const onChangeVideoFps = useCallback(
    (value: number | undefined) => updateNodeData(activeNodeId!, { videoFps: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeSeedanceResolution = useCallback(
    (value: string | undefined) => updateNodeData(activeNodeId!, { seedanceResolution: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeSeedanceRatio = useCallback(
    (value: string | undefined) => updateNodeData(activeNodeId!, { seedanceRatio: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeSeedanceDuration = useCallback(
    (value: number | undefined) => updateContinuousNodeData({ seedanceDuration: value }),
    [updateContinuousNodeData]
  );

  const onChangeGenerateAudio = useCallback(
    (value: boolean | undefined) => updateNodeData(activeNodeId!, { generateAudio: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeVideoReferences = useCallback(
    (value: VideoReferenceItem[]) => updateNodeData(activeNodeId!, { videoReferences: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeAudioSpeechSettings = useCallback((value: AudioSpeechSettings) => {
    updateContinuousNodeData({ audioSpeechSettings: value });
  }, [updateContinuousNodeData]);

  const onRemoveAudioReference = useCallback((reference: AudioSpeechReference) => {
    finishContinuousEdit();
    const state = useAppStore.getState();
    const current = state.nodes.find((item) => item.id === activeNodeId)?.data;
    if (!current || !activeNodeId) return;
    if (reference.edgeId) {
      state.onEdgesChange([{ type: 'remove', id: reference.edgeId }]);
    } else {
      updateNodeData(activeNodeId, removeAudioSpeechReference(current.prompt ?? '', current.workflowInputs, reference));
    }
  }, [activeNodeId, finishContinuousEdit, updateNodeData]);

  const onChangeAudioVoice = useCallback(
    (value: AudioTtsVoice) => updateNodeData(activeNodeId!, { audioVoice: value }),
    [activeNodeId, updateNodeData],
  );

  const onChangeAudioFormat = useCallback(
    (value: AudioOutputFormat) => updateNodeData(activeNodeId!, { audioFormat: value }),
    [activeNodeId, updateNodeData],
  );

  const onChangeAudioSpeed = useCallback(
    (value: number) => updateContinuousNodeData({ audioSpeed: value }),
    [updateContinuousNodeData],
  );

  const onChangeMusicTitle = useCallback(
    (value: string) => updateContinuousNodeData({ musicTitle: value }),
    [updateContinuousNodeData],
  );

  const onChangeMusicLyrics = useCallback(
    (value: string) => updateContinuousNodeData({ musicLyrics: value }),
    [updateContinuousNodeData],
  );

  const onChangeMusicBpm = useCallback(
    (value: number | undefined) => updateContinuousNodeData({ musicBpm: value }),
    [updateContinuousNodeData],
  );

  const onChangeMusicDuration = useCallback(
    (value: number) => updateContinuousNodeData({ musicDuration: value }),
    [updateContinuousNodeData],
  );

  const onChangeAutoGenerateLyrics = useCallback(
    (value: boolean) => updateNodeData(activeNodeId!, { autoGenerateLyrics: value }),
    [activeNodeId, updateNodeData],
  );

  const onStyleChange = useCallback(
    (styleId: string) => updateNodeData(activeNodeId!, { style: styleId }),
    [activeNodeId, updateNodeData]
  );

  const onAnimationActionChange = useCallback(
    (action: AnimationAction) => updateNodeData(activeNodeId!, { animationAction: action }),
    [activeNodeId, updateNodeData]
  );

  const onAnimationFramesChange = useCallback(
    (value: number) => updateNodeData(activeNodeId!, { animationFrames: value as BaseNodeData['animationFrames'] }),
    [activeNodeId, updateNodeData]
  );

  return {
    onChangeImageSize, onChangeImageQuality, onChangeImageBackground, onChangeImageOutputParameters,
    onChangeAspectRatio, onWorkflowInputsChange, onChangeBatchCount, onChangeCameraSettings,
    onChangeVideoResolution, onChangeVideoFps, onChangeSeedanceResolution, onChangeSeedanceRatio,
    onChangeSeedanceDuration, onChangeGenerateAudio, onChangeVideoReferences, onChangeAudioSpeechSettings,
    onRemoveAudioReference, onChangeAudioVoice, onChangeAudioFormat, onChangeAudioSpeed, onChangeMusicTitle,
    onChangeMusicLyrics, onChangeMusicBpm, onChangeMusicDuration, onChangeAutoGenerateLyrics, onStyleChange,
    onAnimationActionChange, onAnimationFramesChange,
  };
}
