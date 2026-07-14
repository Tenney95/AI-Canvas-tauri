/**
 * SlashCommandMenu — / 指令弹出菜单
 * 显示内置快捷指令 + 用户自定义快捷指令，支持子菜单，选中后插入模板到提示词
 */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import type { ImagePostProcess, NodeType, UserPreset, UserSkill } from '../../../types';

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

const SKILL_PARENT_ID = '__skills__';

interface SlashCommandMenuProps {
  nodeType: NodeType;
  currentPrompt: string;
  anchorEl: HTMLElement | null;
  userPresets: UserPreset[];
  userSkills: UserSkill[];
  onSelect: (prompt: string, shouldTrigger: boolean, preset?: PresetOverride) => void;
  onSelectSkill: (skill: UserSkill) => void;
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
  userSkills,
  onSelect,
  onSelectSkill,
  onUploadSkill,
  onManageSkills,
  onClose,
  onManagePresets,
}: SlashCommandMenuProps) {
  const [activeParentId, setActiveParentId] = useState<string | null>(null);
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ left: number; top: number; direction: 'left' | 'right' }>({ left: 0, top: 0, direction: 'right' });
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  const commands = getSlashCommands(nodeType);

  // Filter user presets for current node type
  const matchingPresets = userPresets.filter((p) => p.nodeType === nodeType);

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
    + matchingPresets.length
    + 1 /* skill submenu */
    + 1 /* manage */
    + (commands.length > 0 ? 1 : 0) /* header */
    + (matchingPresets.length > 0 ? 2 : 0) /* header+divider */
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

  const updateSubmenuPositionByCount = useCallback((itemCountForSubmenu: number) => {
    if (!menuRef.current) return;
    const parentRect = menuRef.current.getBoundingClientRect();
    const subW = 268;
    const subH = itemCountForSubmenu * 48 + 16;

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
    if (preset.triggerMode === 'direct') {
      const filled = fillTemplate(preset.promptTemplate, currentPrompt);
      onSelect(filled, true, preset);
    } else {
      const filled = fillTemplate(preset.promptTemplate, currentPrompt);
      onSelect(currentPrompt ? `${currentPrompt}\n${filled}` : filled, false, preset);
    }
    onClose();
  }, [currentPrompt, onSelect, onClose]);

  const handleSkillSelect = useCallback((skill: UserSkill) => {
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
    updateSubmenuPositionByCount(userSkills.length + 3);
  }, [updateSubmenuPositionByCount, userSkills.length]);

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
        {matchingPresets.length > 0 && (
          <>
            {commands.length > 0 && <div className="slash-command-divider" />}
            <div className="slash-command-header slash-command-header--user">快捷指令</div>
            {matchingPresets.map((preset) => (
              <div
                key={preset.id}
                className="slash-command-item has-trigger slash-command-user-preset"
                onClick={() => handlePresetSelect(preset)}
              >
                {renderIcon(preset.icon || 'mdi:star')}
                <div className="slash-command-text">
                  <span className="slash-command-title">{preset.name}</span>
                  <span className="slash-command-desc">{preset.description || '点击调用这个快捷指令'}</span>
                </div>
                <span className="slash-command-badge">
                  {preset.triggerMode === 'direct' ? '直接触发' : '加入提示词'}
                </span>
              </div>
            ))}
          </>
        )}

        {(commands.length > 0 || matchingPresets.length > 0) && <div className="slash-command-divider" />}
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

      {skillMenuActive && (
        <div
          ref={submenuRef}
          className="slash-command-submenu"
          style={{
            left: submenuPos.left,
            top: submenuPos.top,
          }}
        >
          {userSkills.map((skill) => (
            <div
              key={skill.id}
              className={`slash-command-item has-trigger${hoveredItemId === skill.id ? ' active' : ''}`}
              onClick={() => handleSkillSelect(skill)}
              onMouseEnter={() => setHoveredItemId(skill.id)}
            >
              <div className="slash-command-text">
                <span className="slash-command-title">{skill.name}</span>
                <span className="slash-command-desc">{skill.description || skill.fileName}</span>
              </div>
              <span className="slash-command-badge">调用</span>
            </div>
          ))}
          {userSkills.length > 0 && <div className="slash-command-divider" />}
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
