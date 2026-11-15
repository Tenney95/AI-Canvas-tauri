/**
 * AudioNodeToolbar 音频节点浮动工具栏 + 编辑态支持
 */
import { useT } from '../../../i18n';
import { memo, useCallback } from 'react';
import { Icon } from '@iconify/react';
import AnimatedButton from '../../shared/AnimatedButton';
import { useToolbarEdit } from '../../../hooks/useToolbarEdit';
import ToolbarEditor from './toolbar/ToolbarEditor';
import ToolbarZones from './toolbar/ToolbarZones';
import { useNodePluginToolbar } from './toolbar/NodePluginToolbarButtons';
import { getHiddenDefaultToolbarButtons } from './toolbar/toolbarRegistry';
import { executeToolbarPreset, resolvePresetDef } from './toolbar/presetAction';
import { useAppStore } from '../../../store/useAppStore';

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
  const t = useT();
  const nodeType = 'ai-audio';
  const edit = useToolbarEdit({ nodeType });
  const registry = edit.registry;
  const pluginToolbar = useNodePluginToolbar({ nodeId });
  const userPresets = useAppStore((s) => s.userPresets);

  const handlePresetClick = useCallback(
    (key: string) => (e: React.MouseEvent) => {
      e.stopPropagation();
      executeToolbarPreset(key, nodeType, nodeId);
    },
    [nodeId],
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
      className="ftb-btn icon-only"
      data-tooltip={t(isTranscribing ? '正在转录' : '转录音频')}
      aria-label={t(isTranscribing ? '正在转录音频' : '转录音频')}
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

    const presetDef = !def ? resolvePresetDef(key, nodeType, userPresets) : null;
    if (!def && !presetDef) return null;

    const resolvedDef = def ?? { key, label: presetDef!.label, icon: presetDef!.icon, defaultZone: '' };
    const clickHandler = handler ?? handlePresetClick(key);

    if (key === 'togglePlay') {
      return (
        <AnimatedButton key={key} className="ftb-btn icon-only act-toggle-play"
          data-tooltip={t(isPlaying ? '暂停' : '播放')} aria-label={t(isPlaying ? '暂停' : '播放')}
          onClick={clickHandler}>
          <Icon icon={isPlaying ? 'mdi:pause' : 'mdi:play'} width={14} height={14} />
        </AnimatedButton>
      );
    }

    if (key === 'transcribe') return renderTranscribeButton(key);

    if (key === 'speechToText') {
      const tooltip = isAsrRunning
        ? t('正在识别语音{progress}', { progress: asrProgress > 0 ? ` ${asrProgress}%` : '...' })
        : resolvedDef.label;
      return (
        <AnimatedButton key={key} className="ftb-btn icon-only"
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
      <AnimatedButton key={key} className={`ftb-btn icon-only${isPreset ? ' act-preset' : ''}`}
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
      <div className="node-floating-toolbar img-toolbar nodrag" {...edit.longPressHandlers}>
        <div className="img-toolbar-main nodrag">
          <ToolbarZones
            zones={edit.layout.zones}
            hiddenButtons={hiddenDefaultButtons}
            renderButton={renderActionButton}
          />
        </div>
      </div>
      {pluginToolbar.dialog}
    </>
  );
}

export default memo(AudioNodeToolbar);
