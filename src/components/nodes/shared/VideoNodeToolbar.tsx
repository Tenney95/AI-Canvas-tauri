/**
 * VideoNodeToolbar 视频节点浮动工具栏 + 编辑态支持
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
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

/** 截帧位置：首帧 / 播放头当前帧 / 尾帧 */
export type CaptureFramePosition = 'first' | 'current' | 'last';

const CAPTURE_FRAME_OPTIONS: { position: CaptureFramePosition; label: string; icon: string }[] = [
  { position: 'first', label: '导出首帧', icon: 'mdi:page-first' },
  { position: 'current', label: '导出当前帧', icon: 'mdi:camera-outline' },
  { position: 'last', label: '导出尾帧', icon: 'mdi:page-last' },
];

interface VideoNodeToolbarProps {
  nodeId: string;
  onCaptureFrame: (position: CaptureFramePosition) => void;
  onFullscreen: () => void;
  onCopyFile: () => void;
  onReversePrompt: () => void;
  onShowPrompt: () => void;
  isReversingPrompt?: boolean;
}

function VideoNodeToolbar({
  nodeId, onCaptureFrame, onFullscreen, onCopyFile, onReversePrompt, onShowPrompt, isReversingPrompt,
}: VideoNodeToolbarProps) {
  const nodeType = 'ai-video';
  const edit = useToolbarEdit({ nodeType });
  const registry = edit.registry;
  const pluginToolbar = useNodePluginToolbar({ nodeId });
  const userPresets = useAppStore((s) => s.userPresets);
  const addNodeWithEdge = useAppStore((s) => s.addNodeWithEdge);

  // ── 截帧子菜单：与图像节点的宫格菜单同一套结构与样式 ──
  const [frameMenuOpen, setFrameMenuOpen] = useState(false);
  const [frameMenuBelow, setFrameMenuBelow] = useState(false);
  const frameWrapRef = useRef<HTMLDivElement>(null);
  const frameMenuRef = useRef<HTMLDivElement>(null);

  const toggleFrameMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setFrameMenuOpen((open) => !open);
  }, []);

  // 工具栏贴在节点顶部，上方放不下时翻到按钮下面
  useEffect(() => {
    if (!frameMenuOpen) return;
    const raf = requestAnimationFrame(() => {
      const anchor = frameWrapRef.current;
      const menu = frameMenuRef.current;
      if (!anchor || !menu) return;
      setFrameMenuBelow(anchor.getBoundingClientRect().top - menu.offsetHeight - 12 < 0);
    });
    return () => cancelAnimationFrame(raf);
  }, [frameMenuOpen]);

  useEffect(() => {
    if (!frameMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (frameWrapRef.current && !frameWrapRef.current.contains(e.target as unknown as globalThis.Node)) {
        setFrameMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [frameMenuOpen]);

  const pickFrame = useCallback((position: CaptureFramePosition) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setFrameMenuOpen(false);
    onCaptureFrame(position);
  }, [onCaptureFrame]);

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
    copyFile: (e) => { e.stopPropagation(); onCopyFile(); },
    captureFrame: toggleFrameMenu,
    showPrompt: (e) => { e.stopPropagation(); onShowPrompt(); },
    reversePrompt: (e) => { e.stopPropagation(); if (!isReversingPrompt) onReversePrompt(); },
    fullscreen: (e) => { e.stopPropagation(); onFullscreen(); },
  };
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

    if (key === 'captureFrame') {
      return (
        <div key={key} className="multigrid-wrap" ref={frameWrapRef}>
          <AnimatedButton
            className="ftb-btn icon-only act-captureFrame"
            data-tooltip={resolvedDef.label}
            aria-label={resolvedDef.label}
            onClick={clickHandler}
          >
            <Icon icon={resolvedDef.icon} width={14} height={14} />
          </AnimatedButton>
          {frameMenuOpen && (
            <div
              ref={frameMenuRef}
              className={`multigrid-menu nodrag${frameMenuBelow ? ' multigrid-menu--below' : ''}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="multigrid-menu-title">截取哪一帧</div>
              {CAPTURE_FRAME_OPTIONS.map((option) => (
                <button
                  key={option.position}
                  type="button"
                  className="multigrid-menu-item"
                  onClick={pickFrame(option.position)}
                >
                  <Icon icon={option.icon} width={15} height={15} />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }

    const isReversing = key === 'reversePrompt' && isReversingPrompt;
    return (
      <AnimatedButton
        key={key}
        className={`ftb-btn icon-only ${isPreset ? 'act-preset' : `act-${key}`}`}
        data-tooltip={isReversing ? '反推中...' : resolvedDef.label}
        aria-label={resolvedDef.label}
        disabled={isReversing}
        onClick={clickHandler}
      >
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
      </div>
      {pluginToolbar.dialog}
    </>
  );
}

export default memo(VideoNodeToolbar);
