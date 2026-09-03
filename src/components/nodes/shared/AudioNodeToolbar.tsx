/**
 * AudioNodeToolbar 音频节点浮动工具栏 + 编辑态支持
 */
import { memo, useCallback } from 'react';
import { Icon } from '@iconify/react';
import type { NodeType, BaseNodeData } from '../../../types';
import AnimatedButton from '../../shared/AnimatedButton';
import { useToolbarEdit } from '../../../hooks/useToolbarEdit';
import ToolbarEditor from './toolbar/ToolbarEditor';
import ToolbarMoreMenu from './toolbar/ToolbarMoreMenu';
import { useNodePluginToolbar } from './toolbar/NodePluginToolbarButtons';
import {
  getHiddenDefaultToolbarButtons,
  TOOLBAR_MORE_KEY,
} from './toolbar/toolbarRegistry';
import { resolvePresetAction, resolvePresetDef, createPresetNode } from './toolbar/presetAction';
import { executeGeneration } from '../../../services/generationService';
import { requestPresetSequence } from '../../../services/presetSequenceService';
import { useAppStore } from '../../../store/useAppStore';
import type { Node } from '@xyflow/react';

interface AudioNodeToolbarProps {
  nodeId: string;
  isPlaying?: boolean;
  isTranscribing?: boolean;
  isAsrRunning?: boolean;
  /** 本地语音转文本进度百分比（0–100），仅在转写过程中有意义 */
  asrProgress?: number;
  onTogglePlay: (e: React.MouseEvent) => void;
  onTranscribe: () => void;
  onSpeechToText: () => void;
  onUpload: () => void;
  onCopyFile: () => void;
}

function AudioNodeToolbar({
  nodeId,
  isPlaying,
  isTranscribing,
  isAsrRunning,
  asrProgress = 0,
  onTogglePlay,
  onTranscribe,
  onSpeechToText,
  onUpload,
  onCopyFile,
}: AudioNodeToolbarProps) {
  const nodeType = 'ai-audio';
  const edit = useToolbarEdit({ nodeType });
  const registry = edit.registry;
  const pluginToolbar = useNodePluginToolbar({ nodeId, rounded: true });
  const userPresets = useAppStore((s) => s.userPresets);
  const addNodeWithEdge = useAppStore((s) => s.addNodeWithEdge);

  const handlePresetClick = useCallback(
    (key: string) => (e: React.MouseEvent) => {
      e.stopPropagation();
      // 实时从 store 读取，避免闭包过期导致对话框内容/ @引用丢失
      const liveNode = useAppStore.getState().nodes.find((n) => n.id === nodeId) as Node<BaseNodeData> | undefined;
      if (!liveNode) return;
      const livePrompt = (liveNode.data?.prompt as string) ?? '';
      const livePresets = useAppStore.getState().userPresets;
      if (requestPresetSequence(key, nodeType as NodeType, nodeId, livePresets)) return;
      const resolved = resolvePresetAction(key, nodeType as NodeType, livePrompt, livePresets);
      if (!resolved) return;
      const { node: newNode, edge } = createPresetNode(liveNode, resolved);
      addNodeWithEdge(newNode, edge);
      executeGeneration(newNode.id, newNode.data.prompt, resolved.postProcess, newNode.data);
    },
    [nodeId, addNodeWithEdge],
  );

  const actionMap: Record<string, (e: React.MouseEvent) => void> = {
    togglePlay: (e) => { e.stopPropagation(); onTogglePlay(e); },
    transcribe: (e) => { e.stopPropagation(); onTranscribe(); },
    speechToText: (e) => { e.stopPropagation(); if (!isAsrRunning) onSpeechToText(); },
    copyFile:   (e) => { e.stopPropagation(); onCopyFile(); },
    upload:     (e) => { e.stopPropagation(); onUpload(); },
  };

  const renderTranscribeButton = (key: string) => (
    <AnimatedButton
      key={key}
      className="ftb-btn icon-only rounded-[6px]"
      data-tooltip={isTranscribing ? '正在转录' : '转录音频'}
      aria-label={isTranscribing ? '正在转录音频' : '转录音频'}
      disabled={isTranscribing}
      onClick={actionMap.transcribe}
    >
      <Icon
        icon={isTranscribing ? 'mdi:loading' : 'mdi:text-box-search-outline'}
        className={isTranscribing ? 'animate-spin' : undefined}
        width={14}
        height={14}
      />
    </AnimatedButton>
  );
  const hiddenDefaultButtons = getHiddenDefaultToolbarButtons(registry, edit.activeButtonKeys);

  const renderActionButton = (key: string) => {
    const pluginButton = pluginToolbar.renderButton(key);
    if (pluginButton) return pluginButton;
    const def = registry.find((button) => button.key === key);
    const handler = actionMap[key];
    const isPreset = !def;

    const presetDef = !def ? resolvePresetDef(key, nodeType as NodeType, userPresets) : null;
    if (!def && !presetDef) return null;

    const resolvedDef = def ?? { key, label: presetDef!.label, icon: presetDef!.icon, defaultZone: '' };
    const clickHandler = handler ?? handlePresetClick(key);

    if (key === 'togglePlay') {
      return (
        <AnimatedButton key={key} className="ftb-btn icon-only act-toggle-play rounded-[6px]"
          data-tooltip={isPlaying ? '暂停' : '播放'} aria-label={isPlaying ? '暂停' : '播放'}
          onClick={clickHandler}>
          <Icon icon={isPlaying ? 'mdi:pause' : 'mdi:play'} width={14} height={14} />
        </AnimatedButton>
      );
    }

    if (key === 'transcribe') return renderTranscribeButton(key);

    if (key === 'speechToText') {
      const tooltip = isAsrRunning
        ? `正在识别语音${asrProgress > 0 ? ` ${asrProgress}%` : '...'}`
        : resolvedDef.label;
      return (
        <AnimatedButton key={key} className="ftb-btn icon-only rounded-[6px]"
          data-tooltip={tooltip}
          aria-label={tooltip}
          disabled={isAsrRunning}
          onClick={clickHandler}>
          <Icon
            icon={isAsrRunning ? 'mdi:loading' : resolvedDef.icon}
            className={isAsrRunning ? 'animate-spin' : undefined}
            width={14}
            height={14}
          />
        </AnimatedButton>
      );
    }

    return (
      <AnimatedButton key={key} className={`ftb-btn icon-only${isPreset ? ' act-preset' : ''} rounded-[6px]`}
        data-tooltip={resolvedDef.label} aria-label={resolvedDef.label} onClick={clickHandler}>
        <Icon icon={resolvedDef.icon} width={14} height={14} />
      </AnimatedButton>
    );
  };

  if (edit.isEditing) {
    return <ToolbarEditor edit={edit} nodeType={nodeType} />;
  }

  return (
    <>
      <div className="node-floating-toolbar text-toolbar nodrag" {...edit.longPressHandlers}>
        {edit.layout.zones.map((zone, zi) => (
          <div key={zone.id} className="img-toolbar-zone nodrag">
            {zone.buttonKeys.map((key) => (
              key === TOOLBAR_MORE_KEY
                ? (
                  <ToolbarMoreMenu
                    key={key}
                    items={hiddenDefaultButtons}
                    renderItem={renderActionButton}
                  />
                )
                : renderActionButton(key)
            ))}
            {zi < edit.layout.zones.length - 1 && <div className="ftb-divider img-toolbar-main-divider" />}
          </div>
        ))}
      </div>
      {pluginToolbar.dialog}
    </>
  );
}

export default memo(AudioNodeToolbar);
