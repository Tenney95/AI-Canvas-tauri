/**
 * canvas/CanvasRadialMenu — 画布长按弹出的环形快捷菜单。
 * 展示 6 个可配置槽位（ComfyUI、工作流、素材库、设置、项目库、适应画布等），
 * 支持拖拽改键（custom-url 打开自定义网页）、空白槽位，并根据视口边界自动校正弹出位置。
 */
import { useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import { invoke } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import type {
  CanvasQuickAction,
  CanvasQuickActionKind,
} from '../../types';
import type { CanvasRadialMenuPosition } from '../../hooks/useCanvasLongPressRadialMenu';
import { useT } from '../../i18n';

const SLOT_COUNT = 6;
const MENU_VIEWPORT_PADDING = 122;

interface ActionDefinition {
  kind: CanvasQuickActionKind;
  label: string;
  icon: string;
}

const ACTION_DEFINITIONS: ActionDefinition[] = [
  { kind: 'comfyui', label: 'ComfyUI', icon: 'solar:magic-stick-3-bold-duotone' },
  { kind: 'workflows', label: '工作流', icon: 'solar:diagram-up-bold-duotone' },
  { kind: 'assets', label: '素材库', icon: 'solar:gallery-wide-bold-duotone' },
  { kind: 'settings', label: '设置', icon: 'solar:settings-bold-duotone' },
  { kind: 'projects', label: '项目库', icon: 'solar:folder-with-files-bold-duotone' },
  { kind: 'video-editor', label: '视频编辑器', icon: 'solar:clapperboard-play-bold-duotone' },
  { kind: 'action-library', label: '动作库', icon: 'lucide:accessibility' },
  { kind: 'fit-view', label: '适应画布', icon: 'solar:maximize-square-3-bold-duotone' },
  { kind: 'custom-url', label: '自定义网页', icon: 'solar:link-round-angle-bold-duotone' },
  { kind: 'disabled', label: '留空', icon: 'solar:minus-circle-bold-duotone' },
];

const DEFINITION_BY_KIND = new Map(ACTION_DEFINITIONS.map((definition) => [definition.kind, definition]));

const DEFAULT_CANVAS_QUICK_ACTIONS: CanvasQuickAction[] = [
  { id: 'canvas-quick-comfyui', kind: 'comfyui' },
  { id: 'canvas-quick-workflows', kind: 'workflows' },
  { id: 'canvas-quick-video-editor', kind: 'video-editor' },
  { id: 'canvas-quick-settings', kind: 'settings' },
  { id: 'canvas-quick-action-library', kind: 'action-library' },
  { id: 'canvas-quick-fit-view', kind: 'fit-view' },
];

function normalizeCanvasQuickActions(actions: CanvasQuickAction[] | undefined): CanvasQuickAction[] {
  return Array.from({ length: SLOT_COUNT }, (_, index) => {
    const action = actions?.[index] ?? DEFAULT_CANVAS_QUICK_ACTIONS[index];
    const kind = DEFINITION_BY_KIND.has(action.kind) ? action.kind : 'disabled';
    return {
      id: action.id || `canvas-quick-slot-${index}`,
      kind,
      label: action.label?.slice(0, 24),
      url: action.url?.slice(0, 2_048),
    };
  });
}

function getActionLabel(action: CanvasQuickAction): string {
  return action.label?.trim() || DEFINITION_BY_KIND.get(action.kind)?.label || '快捷动作';
}

function getActionIcon(action: CanvasQuickAction): string {
  return DEFINITION_BY_KIND.get(action.kind)?.icon || 'solar:widget-2-bold-duotone';
}

function clampMenuPosition(position: CanvasRadialMenuPosition): CanvasRadialMenuPosition {
  return {
    x: Math.min(Math.max(position.x, MENU_VIEWPORT_PADDING), window.innerWidth - MENU_VIEWPORT_PADDING),
    y: Math.min(Math.max(position.y, MENU_VIEWPORT_PADDING), window.innerHeight - MENU_VIEWPORT_PADDING),
  };
}

async function openExternalUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 网页地址');
  }
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(parsed.toString());
  } catch {
    const opened = window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
    if (!opened) throw new Error('无法打开网页');
  }
}

export function CanvasLongPressIndicator({ position }: { position: CanvasRadialMenuPosition }) {
  return (
    <div
      className="canvas-radial-hold-indicator"
      style={{ left: position.x, top: position.y }}
      aria-hidden="true"
    />
  );
}

interface CanvasRadialMenuProps {
  position: CanvasRadialMenuPosition;
  onClose: () => void;
}

export default function CanvasRadialMenu({ position, onClose }: CanvasRadialMenuProps) {
  const t = useT();
  const {
    configuredActions,
    comfyUIUrl,
    updateConfig,
    saveConfig,
    setWorkflowPanelOpen,
    setAssetsPanelOpen,
    setSettingsOpen,
    setProjectLibraryOpen,
    setCharacterLibraryOpen,
    setCharacterActionLibraryOpen,
    showToast,
  } = useAppStore(useShallow((state) => ({
    configuredActions: state.config.canvasQuickActions,
    comfyUIUrl: state.config.comfyUIUrl,
    updateConfig: state.updateConfig,
    saveConfig: state.saveConfig,
    setWorkflowPanelOpen: state.setWorkflowPanelOpen,
    setAssetsPanelOpen: state.setAssetsPanelOpen,
    setSettingsOpen: state.setSettingsOpen,
    setProjectLibraryOpen: state.setProjectLibraryOpen,
    setCharacterLibraryOpen: state.setCharacterLibraryOpen,
    setCharacterActionLibraryOpen: state.setCharacterActionLibraryOpen,
    showToast: state.showToast,
  })));
  const actions = useMemo(() => normalizeCanvasQuickActions(configuredActions), [configuredActions]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CanvasQuickAction[]>(actions);
  const menuPosition = clampMenuPosition(position);

  const runAction = async (action: CanvasQuickAction) => {
    onClose();
    try {
      switch (action.kind) {
        case 'comfyui':
          await invoke<void>('open_comfyui_window', {
            comfyUrl: comfyUIUrl?.trim() || 'http://127.0.0.1:8188',
          });
          break;
        case 'workflows':
          setWorkflowPanelOpen(true);
          break;
        case 'assets':
          setAssetsPanelOpen(true);
          break;
        case 'settings':
          setSettingsOpen(true);
          break;
        case 'projects':
          setProjectLibraryOpen(true);
          break;
        case 'video-editor': {
          const { currentProjectId, config } = useAppStore.getState();
          const { openVideoEditorBlank } = await import('../../services/videoEditorService');
          await openVideoEditorBlank({
            projectId: currentProjectId ?? '',
            theme: config.theme === 'light' ? 'light' : 'dark',
          });
          break;
        }
        case 'action-library':
          // 动作库弹层依赖选中角色，一个都没有就先把角色库摆出来
          if (useAppStore.getState().dramaAssets.characters.length === 0) {
            setCharacterLibraryOpen(true);
          }
          setCharacterActionLibraryOpen(true);
          break;
        case 'fit-view':
          window.dispatchEvent(new Event('canvas-fit-view'));
          break;
        case 'custom-url':
          if (!action.url?.trim()) throw new Error(t('请先填写网页地址'));
          await openExternalUrl(action.url.trim());
          break;
        case 'disabled':
          break;
      }
    } catch (error) {
      showToast(
        typeof error === 'string'
          ? error
          : error instanceof Error ? error.message : t('快捷动作执行失败'),
        'error',
      );
    }
  };

  const updateDraft = (index: number, patch: Partial<CanvasQuickAction>) => {
    setDraft((current) => current.map((action, actionIndex) => (
      actionIndex === index ? { ...action, ...patch } : action
    )));
  };

  const saveDraft = async () => {
    const normalized = normalizeCanvasQuickActions(draft);
    updateConfig({ canvasQuickActions: normalized });
    await saveConfig({ silent: true });
    showToast(t('画布圆环快捷方式已保存'));
    setEditing(false);
    onClose();
  };

  return (
    <div
      className={`canvas-radial-backdrop${editing ? ' is-editing' : ''}`}
      data-canvas-radial-menu
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {!editing && (
        <div
          className="canvas-radial-menu"
          style={{ left: menuPosition.x, top: menuPosition.y }}
          role="menu"
          aria-label={t('画布快捷方式')}
        >
          {actions.map((action, index) => (
            <button
              key={action.id}
              type="button"
              className={`canvas-radial-item canvas-radial-slot-${index}`}
              disabled={action.kind === 'disabled'}
              role="menuitem"
              aria-label={t(getActionLabel(action))}
              data-tooltip={t(getActionLabel(action))}
              onClick={() => void runAction(action)}
            >
              <Icon icon={getActionIcon(action)} width="21" />
            </button>
          ))}
          <button
            type="button"
            className="canvas-radial-center"
            aria-label={t('自定义圆环快捷方式')}
            onClick={() => {
              setDraft(actions);
              setEditing(true);
            }}
          >
            <Icon icon="solar:pen-new-square-bold-duotone" width="20" />
          </button>
        </div>
      )}

      {editing && (
        <div className="canvas-radial-editor" role="dialog" aria-modal="true" aria-labelledby="canvas-radial-editor-title">
          <div className="canvas-radial-editor-header">
            <div>
              <h2 id="canvas-radial-editor-title">{t('自定义画布圆环')}</h2>
              <p>{t('为 6 个槽位分配常用入口，空白画布长按即可呼出。')}</p>
            </div>
            <button type="button" aria-label={t('关闭')} onClick={() => setEditing(false)}>
              <Icon icon="solar:close-circle-linear" width="22" />
            </button>
          </div>

          <div className="canvas-radial-editor-list">
            {draft.map((action, index) => (
              <div className="canvas-radial-editor-row" key={action.id}>
                <span className="canvas-radial-slot-number">{index + 1}</span>
                <Icon icon={getActionIcon(action)} width="20" />
                <select
                  value={action.kind}
                  aria-label={t('槽位 {index}', { index: index + 1 })}
                  onChange={(event) => updateDraft(index, {
                    kind: event.target.value as CanvasQuickActionKind,
                    label: undefined,
                    url: undefined,
                  })}
                >
                  {ACTION_DEFINITIONS.map((definition) => (
                    <option key={definition.kind} value={definition.kind}>{t(definition.label)}</option>
                  ))}
                </select>
                {action.kind === 'custom-url' && (
                  <div className="canvas-radial-custom-fields">
                    <input
                      value={action.label ?? ''}
                      maxLength={24}
                      placeholder={t('名称')}
                      aria-label={t('槽位 {index} 名称', { index: index + 1 })}
                      onChange={(event) => updateDraft(index, { label: event.target.value })}
                    />
                    <input
                      value={action.url ?? ''}
                      inputMode="url"
                      placeholder="https://example.com"
                      aria-label={t('槽位 {index} 网址', { index: index + 1 })}
                      onChange={(event) => updateDraft(index, { url: event.target.value })}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="canvas-radial-editor-actions">
            <button type="button" className="is-secondary" onClick={() => setDraft(DEFAULT_CANVAS_QUICK_ACTIONS)}>
              {t('恢复默认')}
            </button>
            <button type="button" className="is-primary" onClick={() => void saveDraft()}>
              {t('保存设置')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
