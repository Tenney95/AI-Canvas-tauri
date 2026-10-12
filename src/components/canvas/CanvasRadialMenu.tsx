/**
 * canvas/CanvasRadialMenu — 画布长按弹出的环形快捷菜单。
 * 展示 6 个可配置槽位（ComfyUI、工作流、素材库、设置、项目库、适应画布等），
 * 支持拖拽改键（custom-url 打开自定义网页）、空白槽位，并根据视口边界自动校正弹出位置。
 */
import Select from '../shared/Select';
import { useMemo, useState } from 'react';
import { Icon, type IconifyIcon } from '@iconify/react';
import { invoke } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import type {
  CanvasQuickAction,
  CanvasQuickActionKind,
} from '../../types';
import type { CanvasRadialMenuPosition } from '../../hooks/useCanvasLongPressRadialMenu';
import PopupCloseButton from '../shared/PopupCloseButton';
import { useT } from '../../i18n';

const SLOT_COUNT = 6;
const MENU_VIEWPORT_PADDING = 122;

const COMFYUI_ICON: IconifyIcon = {
  width: 18,
  height: 18,
  body: '<path d="M14.8193 0.600586C15.1248 0.600586 15.3296 0.70893 15.459 0.881836C15.5914 1.05888 15.6471 1.33774 15.5527 1.66895L14.8037 4.30176C14.7063 4.64386 14.4729 4.97024 14.1641 5.21191C13.8544 5.45415 13.496 5.58984 13.1699 5.58984H13.1689L9.5791 5.59668H7.90625C7.52654 5.59668 7.19496 5.84986 7.09082 6.21289L5.69434 11.0889C5.63007 11.3133 5.66134 11.5534 5.77734 11.7529L5.83203 11.8359C5.99177 12.0491 6.24252 12.1758 6.50977 12.1758H6.51074L8.88281 12.1709H11.4971C11.7643 12.171 11.9541 12.254 12.084 12.3906L12.1357 12.4521C12.2685 12.6295 12.3249 12.9089 12.2305 13.2402L11.4805 15.8721C11.383 16.2144 11.1498 16.5415 10.8408 16.7832C10.5314 17.0252 10.1736 17.161 9.84766 17.1611H9.84668L6.25684 17.168H3.64258C3.33762 17.1679 3.13349 17.0588 3.00391 16.8857C2.87135 16.7087 2.81482 16.43 2.90918 16.0986L3.39551 14.3887C3.46841 14.1327 3.41794 13.8576 3.25879 13.6445V13.6436C3.09901 13.4303 2.84745 13.3037 2.58008 13.3037H1.18066C0.875088 13.3037 0.670398 13.1953 0.541016 13.0225C0.408483 12.8451 0.351891 12.5655 0.446289 12.2344L2.11914 6.38965L2.30371 5.74707V5.74609C2.40139 5.40341 2.63456 5.07671 2.94336 4.83496C3.25302 4.59258 3.61143 4.45705 3.9375 4.45703H5.6123C5.94484 4.45703 6.24083 4.26316 6.37891 3.9707L6.42773 3.83984L6.98145 1.89551C7.07894 1.55317 7.31212 1.22614 7.62109 0.984375C7.93074 0.742127 8.2892 0.606445 8.61523 0.606445H8.61621L12.1982 0.600586H14.8193Z" fill="currentColor"/>',
};

interface ActionDefinition {
  kind: CanvasQuickActionKind;
  label: string;
  icon: string | IconifyIcon;
}

const ACTION_DEFINITIONS: ActionDefinition[] = [
  { kind: 'comfyui', label: 'ComfyUI', icon: COMFYUI_ICON },
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

function getActionIcon(action: CanvasQuickAction): string | IconifyIcon {
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
          window.dispatchEvent(new CustomEvent('canvas-fit-view', { detail: { source: 'user' } }));
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
    try { await saveConfig({ silent: true }); } catch { return; }
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
            <PopupCloseButton ariaLabel={t('关闭')} onClick={() => setEditing(false)} />
          </div>

          <div className="canvas-radial-editor-list">
            {draft.map((action, index) => (
              <div className="canvas-radial-editor-row" key={action.id}>
                <span className="canvas-radial-slot-number">{index + 1}</span>
                <Icon icon={getActionIcon(action)} width="20" />
                <Select fixedMenu
                  value={action.kind}
                  aria-label={t('槽位 {index}', { index: index + 1 })}
                  onChange={(selectedOptionValue) => updateDraft(index, {
                    kind: selectedOptionValue as CanvasQuickActionKind,
                    label: undefined,
                    url: undefined,
                  })}
                >
                  {ACTION_DEFINITIONS.map((definition) => (
                    <option key={definition.kind} value={definition.kind}>{t(definition.label)}</option>
                  ))}
                </Select>
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
