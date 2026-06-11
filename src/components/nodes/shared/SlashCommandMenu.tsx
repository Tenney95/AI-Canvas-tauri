/**
 * SlashCommandMenu — / 指令弹出菜单
 * 显示预设提示词分类 + 用户自定义预设，支持子菜单，选中后插入模板到提示词
 */
import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { NodeType, UserPreset } from '../../../types';
import { getSlashCommands, fillTemplate } from './slashCommands';
import type { SlashCommandItem } from './slashCommands';
import { calcFixedPosition, calcSubmenuPosition } from '../../../utils/popupPosition';

interface SlashCommandMenuProps {
  nodeType: NodeType;
  currentPrompt: string;
  anchorEl: HTMLElement | null;
  userPresets: UserPreset[];
  onSelect: (prompt: string, shouldTrigger: boolean) => void;
  onClose: () => void;
  onManagePresets: () => void;
}

export default function SlashCommandMenu({
  nodeType,
  currentPrompt,
  anchorEl,
  userPresets,
  onSelect,
  onClose,
  onManagePresets,
}: SlashCommandMenuProps) {
  const [activeParentId, setActiveParentId] = useState<string | null>(null);
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
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
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [handleClickOutside]);

  // Auto-close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 计算菜单位置并做边界检测
  useLayoutEffect(() => {
    if (!anchorEl) return;
    const anchorRect = anchorEl.getBoundingClientRect();

    // 估算主菜单尺寸
    const itemCount = commands.length + matchingPresets.length + 1 /* manage */ + (commands.length > 0 ? 1 : 0) /* header */ + (matchingPresets.length > 0 ? 2 : 0) /* header+divider */;
    const estH = Math.min(16 + itemCount * 48 + 8 /* divider */, 400);
    const estW = 268;

    // 期望位置：锚点上方，水平居中于锚点
    const desiredX = anchorRect.left + anchorRect.width / 2 - estW / 2;
    const desiredY = anchorRect.top - estH - 8;

    setMenuPos(calcFixedPosition(desiredX, desiredY, estW, estH));
  }, [anchorEl, commands.length, matchingPresets.length]);

  const activeParent = commands.find(c => c.id === activeParentId);

  // 子菜单位置计算
  useLayoutEffect(() => {
    if (!activeParent || !menuRef.current) return;
    const parentRect = menuRef.current.getBoundingClientRect();
    const subW = 268;
    const subH = (activeParent.children?.length ?? 0) * 48 + 16;

    setSubmenuPos(calcSubmenuPosition(parentRect, subW, subH));
  }, [activeParent, commands]);

  const handleItemSelect = useCallback((item: SlashCommandItem) => {
    if (item.promptTemplate) {
      const filled = fillTemplate(item.promptTemplate, currentPrompt);
      // Built-in commands always trigger directly: concatenate current input + template → trigger
      onSelect(filled, true);
      onClose();
    }
  }, [currentPrompt, onSelect, onClose]);

  const handlePresetSelect = useCallback((preset: UserPreset) => {
    if (preset.triggerMode === 'direct') {
      // Direct trigger: fill template with current input → trigger immediately
      const filled = fillTemplate(preset.promptTemplate, currentPrompt);
      onSelect(filled, true);
    } else {
      // Insert mode: append template to current prompt, don't trigger
      const filled = fillTemplate(preset.promptTemplate, currentPrompt);
      onSelect(currentPrompt ? `${currentPrompt}\n${filled}` : filled, false);
    }
    onClose();
  }, [currentPrompt, onSelect, onClose]);

  const handleItemHover = useCallback((item: SlashCommandItem) => {
    if (item.children) {
      setActiveParentId(item.id);
      setHoveredItemId(item.id);
    } else {
      setActiveParentId(null);
    }
  }, []);

  const hasContent = commands.length > 0 || matchingPresets.length > 0;
  if (!hasContent) return null;

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
            <div className="slash-command-header">选择预设生成</div>
            {commands.map((item) => (
              <div
                key={item.id}
                className={`slash-command-item${item.children ? ' has-submenu' : ' has-trigger'}${(item.children && activeParentId === item.id) ? ' active' : ''}`}
                data-item-id={item.id}
                onMouseEnter={() => handleItemHover(item)}
                onClick={() => {
                  if (item.children) {
                    setActiveParentId(activeParentId === item.id ? null : item.id);
                  } else {
                    handleItemSelect(item);
                  }
                }}
              >
                <span className="slash-command-icon">{item.icon}</span>
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
            <div className="slash-command-header slash-command-header--user">我的预设</div>
            {matchingPresets.map((preset) => (
              <div
                key={preset.id}
                className="slash-command-item has-trigger slash-command-user-preset"
                onClick={() => handlePresetSelect(preset)}
              >
                <span className="slash-command-icon">
                  {preset.thumbnail ? (
                    <img
                      className="slash-command-thumb"
                      src={preset.thumbnail}
                      alt=""
                      style={{ width: 22, height: 22, borderRadius: 4, objectFit: 'cover' }}
                    />
                  ) : (
                    preset.nodeType === 'ai-image' ? '🎨' :
                    preset.nodeType === 'ai-video' ? '🎬' :
                    preset.nodeType === 'ai-audio' ? '🎵' : '📝'
                  )}
                </span>
                <div className="slash-command-text">
                  <span className="slash-command-title">{preset.name}</span>
                  <span className="slash-command-desc">{preset.description}</span>
                </div>
                <span className="slash-command-badge">
                  {preset.triggerMode === 'direct' ? '直接触发' : '加入提示词'}
                </span>
              </div>
            ))}
          </>
        )}

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
              管理预设
            </span>
            <span className="slash-command-desc">创建和管理自定义提示词预设</span>
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
              <span className="slash-command-icon">{child.icon}</span>
              <div className="slash-command-text">
                <span className="slash-command-title">{child.title}</span>
                <span className="slash-command-desc">{child.description}</span>
              </div>
              <span className="slash-command-badge">直接触发</span>
            </div>
          ))}
        </div>
      )}
    </>,
    document.body,
  );
}
