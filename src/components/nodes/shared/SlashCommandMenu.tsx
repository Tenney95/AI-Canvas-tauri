/**
 * SlashCommandMenu — / 指令弹出菜单
 * 显示内置快捷指令 + 用户自定义快捷指令，支持子菜单，选中后插入模板到提示词
 */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import type { ImagePostProcess, NodeType, PresetFolder, UserPreset } from '../../../types';
import type { SkillPickerOption } from '../../../types/agentPackage';

export interface PresetOverride {
  model?: string;
  provider?: string;
  imageSize?: string;
  aspectRatio?: string;
  postProcess?: ImagePostProcess;
}
import { getSlashCommands, fillTemplate } from './slashCommands';
import type { SlashCommandItem } from './slashCommands';
import { calcFixedPosition, calcSubmenuPosition } from '../../../utils/popupPosition';
import { isAdvancedPreset } from '../../../services/presetSequenceService';
import { groupPresetsByFolder, UNGROUPED_PRESET_FOLDER_ID } from '../../../utils/presetFolders';

const SKILL_PARENT_ID = '__skills__';
const USER_PRESETS_PARENT_ID = '__user_presets__';

interface SlashCommandMenuProps {
  nodeType: NodeType;
  currentPrompt: string;
  anchorEl: HTMLElement | null;
  userPresets: UserPreset[];
  presetFolders?: PresetFolder[];
  skillOptions: SkillPickerOption[];
  onSelect: (prompt: string, shouldTrigger: boolean, preset?: PresetOverride) => void;
  onRunAdvancedPreset: (preset: UserPreset) => void;
  onSelectSkill: (skill: SkillPickerOption) => void;
  onUploadSkill: (source: 'file' | 'folder') => void | Promise<void>;
  onManageSkills: () => void;
  onClose: () => void;
  onManagePresets: () => void;
}

export default function SlashCommandMenu({
  nodeType,
  currentPrompt,
  anchorEl,
  userPresets,
  presetFolders = [],
  skillOptions,
  onSelect,
  onRunAdvancedPreset,
  onSelectSkill,
  onUploadSkill,
  onManageSkills,
  onClose,
  onManagePresets,
}: SlashCommandMenuProps) {
  const invocableSkills = skillOptions;
  const [activeParentId, setActiveParentId] = useState<string | null>(null);
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ left: number; top: number; direction: 'left' | 'right' }>({ left: 0, top: 0, direction: 'right' });
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  const commands = getSlashCommands(nodeType);

  // Filter user presets for current node type
  const presetGroups = groupPresetsByFolder(nodeType, userPresets, presetFolders)
    .filter((group) => group.id !== UNGROUPED_PRESET_FOLDER_ID || group.presets.length > 0);
  const presetMenuActive = activeParentId === USER_PRESETS_PARENT_ID;
  const presetCount = presetGroups.reduce((count, group) => count + group.presets.length, 0);

  // Close on outside click
  const handleClickOutside = useCallback((e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (menuRef.current?.contains(target)) return;
    if (submenuRef.current?.contains(target)) return;
    onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [handleClickOutside]);

  // Auto-close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Render icon: iconify name (contains ':') or emoji
  const renderIcon = (icon: string, className = 'slash-command-icon') => {
    if (icon.includes(':')) {
      return <Icon icon={icon} className={className} width={18} height={18} />;
    }
    return <span className={className}>{icon}</span>;
  };

  const itemCount = commands.length
    + (presetGroups.length > 0 ? 1 : 0)
    + 1 /* skill submenu */
    + 1 /* manage */
    + (commands.length > 0 ? 1 : 0) /* header */
    + (commands.length > 0 && presetGroups.length > 0 ? 1 : 0) /* divider */
    + 2 /* skill divider + action divider */;

  const menuPos = useMemo(() => {
    if (!anchorEl) return { left: 0, top: 0 };
    const anchorRect = anchorEl.getBoundingClientRect();

    // 估算主菜单尺寸
    const estH = Math.min(16 + itemCount * 48 + 8 /* divider */, 400);
    const estW = 268;

    // 期望位置：锚点上方，水平居中于锚点
    const desiredX = anchorRect.left + anchorRect.width / 2 - estW / 2;
    const desiredY = anchorRect.top - estH - 8;

    return calcFixedPosition(desiredX, desiredY, estW, estH);
  }, [anchorEl, itemCount]);

  const activeParent = commands.find(c => c.id === activeParentId);
  const skillMenuActive = activeParentId === SKILL_PARENT_ID;

  const updateSubmenuPositionByCount = useCallback((itemCountForSubmenu: number, anchor?: HTMLElement, rowHeight = 48) => {
    if (!menuRef.current) return;
    const parentRect = (anchor ?? menuRef.current).getBoundingClientRect();
    const subW = 280;
    const subH = Math.min(itemCountForSubmenu * rowHeight + 16, 440);

    setSubmenuPos(calcSubmenuPosition(parentRect, subW, subH));
  }, []);

  const updateSubmenuPosition = useCallback((item: SlashCommandItem) => {
    if (!item.children) return;
    updateSubmenuPositionByCount(item.children.length);
  }, [updateSubmenuPositionByCount]);

  const handleItemSelect = useCallback((item: SlashCommandItem) => {
    if (item.promptTemplate) {
      const filled = fillTemplate(item.promptTemplate, currentPrompt);
      const override: PresetOverride = {};
      if (item.imageSize) override.imageSize = item.imageSize;
      if (item.aspectRatio) override.aspectRatio = item.aspectRatio;
      if (item.postProcess) override.postProcess = item.postProcess;
      onSelect(filled, true, Object.keys(override).length > 0 ? override : undefined);
      onClose();
    }
  }, [currentPrompt, onSelect, onClose]);

  const handlePresetSelect = useCallback((preset: UserPreset) => {
    if (isAdvancedPreset(preset)) {
      onRunAdvancedPreset(preset);
    } else if (preset.triggerMode === 'direct') {
      const filled = fillTemplate(preset.promptTemplate, currentPrompt);
      onSelect(filled, true, preset);
    } else {
      const filled = fillTemplate(preset.promptTemplate, currentPrompt);
      onSelect(currentPrompt ? `${currentPrompt}\n${filled}` : filled, false, preset);
    }
    onClose();
  }, [currentPrompt, onSelect, onRunAdvancedPreset, onClose]);

  const handleSkillSelect = useCallback((skill: SkillPickerOption) => {
    onSelectSkill(skill);
    onClose();
  }, [onSelectSkill, onClose]);

  const handleItemHover = useCallback((item: SlashCommandItem) => {
    if (item.children) {
      setActiveParentId(item.id);
      setHoveredItemId(item.id);
      updateSubmenuPosition(item);
    } else {
      setActiveParentId(null);
    }
  }, [updateSubmenuPosition]);

  const handleSkillHover = useCallback(() => {
    setActiveParentId(SKILL_PARENT_ID);
    setHoveredItemId(SKILL_PARENT_ID);
    updateSubmenuPositionByCount(invocableSkills.length + 3);
  }, [invocableSkills.length, updateSubmenuPositionByCount]);

  const openPresetMenu = (anchor: HTMLElement) => {
    setActiveParentId(USER_PRESETS_PARENT_ID);
    const rows = presetGroups.reduce((count, group) => count + Math.max(group.presets.length, 1)
      + (group.id === UNGROUPED_PRESET_FOLDER_ID ? 0 : 1), 1);
    updateSubmenuPositionByCount(rows, anchor, 36);
  };

  return createPortal(
    <>
      {/* Main menu */}
      <div
        ref={menuRef}
        className="slash-command-menu"
        style={menuPos}
      >
        {/* Built-in commands */}
        {commands.length > 0 && (
          <>
            <div className="slash-command-header">内置快捷指令</div>
            {commands.map((item) => (
              <div
                key={item.id}
                className={`slash-command-item${item.children ? ' has-submenu' : ' has-trigger'}${(item.children && activeParentId === item.id) ? ' active' : ''}`}
                data-item-id={item.id}
                onMouseEnter={() => handleItemHover(item)}
                onClick={() => {
                  if (item.children) {
                    updateSubmenuPosition(item);
                    setActiveParentId(activeParentId === item.id ? null : item.id);
                  } else {
                    handleItemSelect(item);
                  }
                }}
              >
                {renderIcon(item.icon)}
                <div className="slash-command-text">
                  <span className="slash-command-title">
                    {item.title}
                    {item.children && <span className="slash-command-arrow">›</span>}
                  </span>
                  <span className="slash-command-desc">{item.description}</span>
                </div>
                {!item.children && <span className="slash-command-badge">直接触发</span>}
              </div>
            ))}
          </>
        )}

        {/* User presets */}
        {presetGroups.length > 0 && (
          <>
            {commands.length > 0 && <div className="slash-command-divider" />}
            <button
              type="button"
              className={`ui-menu__item slash-command-item has-submenu${presetMenuActive ? ' active' : ''}`}
              data-item-id={USER_PRESETS_PARENT_ID}
              aria-haspopup="menu"
              aria-expanded={presetMenuActive}
              onMouseEnter={(event) => openPresetMenu(event.currentTarget)}
              onFocus={(event) => openPresetMenu(event.currentTarget)}
              onClick={(event) => openPresetMenu(event.currentTarget)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowRight') return;
                event.preventDefault();
                event.stopPropagation();
                openPresetMenu(event.currentTarget);
                requestAnimationFrame(() => submenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
              }}
            >
              {renderIcon('mdi:star-outline')}
              <span className="min-w-0 flex-1 truncate">快捷指令</span>
              <span className="ui-menu__shortcut">{presetCount}</span>
              <span className="slash-command-arrow" aria-hidden="true">›</span>
            </button>
          </>
        )}

        {(commands.length > 0 || presetGroups.length > 0) && <div className="slash-command-divider" />}
        <div
          className={`slash-command-item has-submenu${skillMenuActive ? ' active' : ''}`}
          data-item-id={SKILL_PARENT_ID}
          onMouseEnter={handleSkillHover}
          onClick={() => {
            handleSkillHover();
            setActiveParentId(skillMenuActive ? null : SKILL_PARENT_ID);
          }}
        >
          <span className="slash-command-icon">⚡</span>
          <div className="slash-command-text">
            <span className="slash-command-title">
              Skill
              <span className="slash-command-arrow">›</span>
            </span>
            <span className="slash-command-desc">调用或上传只读 Skill</span>
          </div>
        </div>
        <div className="slash-command-divider" />
        <div
          className="slash-command-item slash-command-manage"
          onClick={() => {
            onManagePresets();
            onClose();
          }}
        >
          <span className="slash-command-icon">⚙️</span>
          <div className="slash-command-text">
            <span className="slash-command-title slash-command-manage-title">
              管理快捷指令
            </span>
            <span className="slash-command-desc">创建和管理自定义提示词模板</span>
          </div>
        </div>
      </div>

      {/* Submenu — positioned right of the main menu */}
      {activeParent && (
        <div
          ref={submenuRef}
          className="slash-command-submenu"
          style={{
            left: submenuPos.left,
            top: submenuPos.top,
          }}
        >
          {activeParent.children?.map((child) => (
            <div
              key={child.id}
              className={`slash-command-item has-trigger${hoveredItemId === child.id ? ' active' : ''}`}
              data-subitem-id={child.id}
              onClick={() => handleItemSelect(child)}
              onMouseEnter={() => setHoveredItemId(child.id)}
            >
              {renderIcon(child.icon)}
              <div className="slash-command-text">
                <span className="slash-command-title">{child.title}</span>
                <span className="slash-command-desc">{child.description}</span>
              </div>
              <span className="slash-command-badge">直接触发</span>
            </div>
          ))}
        </div>
      )}

      {presetMenuActive && presetGroups.length > 0 && (
        <div
          ref={submenuRef}
          className="slash-command-submenu"
          role="menu"
          aria-label="快捷指令"
          style={{ left: submenuPos.left, top: submenuPos.top }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft') return;
            event.preventDefault();
            event.stopPropagation();
            const parent = menuRef.current?.querySelector<HTMLButtonElement>(`[data-item-id="${USER_PRESETS_PARENT_ID}"]`);
            parent?.focus();
            setActiveParentId(null);
          }}
        >
          <div className="ui-menu__label">快捷指令</div>
          {presetGroups.map((group, index) => (
            <div key={group.id} role="group" aria-label={group.id === UNGROUPED_PRESET_FOLDER_ID ? undefined : group.name}>
              {index > 0 && <div className="ui-menu__sep" />}
              {group.id !== UNGROUPED_PRESET_FOLDER_ID && <div className="ui-menu__label truncate" title={group.name}>{group.name}</div>}
              {group.presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  role="menuitem"
                  className="ui-menu__item slash-command-user-preset"
                  title={preset.description?.trim() || preset.name}
                  onClick={() => handlePresetSelect(preset)}
                >
                  {renderIcon(preset.icon || 'mdi:star-outline')}
                  <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                  <span className="ui-badge ui-badge--success shrink-0">
                    {isAdvancedPreset(preset) ? '顺序执行' : preset.triggerMode === 'direct' ? '直接触发' : '加入提示词'}
                  </span>
                </button>
              ))}
              {group.presets.length === 0 && (
                <div className="p-2 text-xs text-canvas-text-muted" role="status">暂无快捷指令</div>
              )}
            </div>
          ))}
        </div>
      )}

      {skillMenuActive && (
        <div
          ref={submenuRef}
          className="slash-command-submenu"
          style={{
            left: submenuPos.left,
            top: submenuPos.top,
          }}
        >
          {invocableSkills.map((skill) => (
            <div
              key={skill.id}
              className={`slash-command-item has-trigger${hoveredItemId === skill.id ? ' active' : ''}`}
              onClick={() => handleSkillSelect(skill)}
              onMouseEnter={() => setHoveredItemId(skill.id)}
            >
              <div className="slash-command-text">
                <span className="slash-command-title">{skill.name}</span>
                <span className="slash-command-desc">
                  {skill.sourceKind === 'agent-package' ? `${skill.sourceLabel} · ` : ''}
                  {skill.description || skill.fileName}
                </span>
              </div>
              <span className="slash-command-badge">调用</span>
            </div>
          ))}
          {invocableSkills.length > 0 && <div className="slash-command-divider" />}
          <div
            className="slash-command-item has-trigger"
            onClick={() => {
              onManageSkills();
              onClose();
            }}
            onMouseEnter={() => setHoveredItemId('manage-skills')}
          >
            <div className="slash-command-text">
              <span className="slash-command-title">管理 Skill</span>
              <span className="slash-command-desc">查看内容和删除已上传 Skill</span>
            </div>
          </div>
          <div className="slash-command-divider" />
          <div
            className="slash-command-item has-trigger"
            onClick={async () => {
              onClose();
              await onUploadSkill('folder');
            }}
            onMouseEnter={() => setHoveredItemId('upload-folder')}
          >
            <div className="slash-command-text">
              <span className="slash-command-title">上传 Skill 文件夹</span>
              <span className="slash-command-desc">保存到应用 skill 目录后调用</span>
            </div>
          </div>
          <div
            className="slash-command-item has-trigger"
            onClick={async () => {
              onClose();
              await onUploadSkill('file');
            }}
            onMouseEnter={() => setHoveredItemId('upload-file')}
          >
            <div className="slash-command-text">
              <span className="slash-command-title">上传 Skill 文件</span>
              <span className="slash-command-desc">选择 .md / .txt / .json 文件</span>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
