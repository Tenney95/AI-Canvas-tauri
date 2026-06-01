/**
 * SlashCommandMenu — / 指令弹出菜单
 * 显示预设提示词分类 + 用户自定义预设，支持子菜单，选中后插入模板到提示词
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { NodeType, UserPreset } from '../../../types';
import { getSlashCommands, fillTemplate } from './slashCommands';
import type { SlashCommandItem } from './slashCommands';

interface SlashCommandMenuProps {
  nodeType: NodeType;
  currentPrompt: string;
  anchorEl: HTMLElement | null;
  userPresets: UserPreset[];
  onSelect: (prompt: string) => void;
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

  const handleItemSelect = useCallback((item: SlashCommandItem) => {
    if (item.promptTemplate) {
      const filled = fillTemplate(item.promptTemplate, currentPrompt);
      onSelect(filled);
      onClose();
    }
  }, [currentPrompt, onSelect, onClose]);

  const handlePresetSelect = useCallback((preset: UserPreset) => {
    if (preset.triggerMode === 'direct') {
      // Direct trigger: replace the entire prompt
      onSelect(fillTemplate(preset.promptTemplate, currentPrompt));
    } else {
      // Insert mode: append template to current prompt
      const filled = fillTemplate(preset.promptTemplate, currentPrompt);
      onSelect(currentPrompt ? `${currentPrompt}\n${filled}` : filled);
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

  const activeParent = commands.find(c => c.id === activeParentId);

  const hasContent = commands.length > 0 || matchingPresets.length > 0;
  if (!hasContent) return null;

  // Position: above the anchor element, right-aligned
  const menuPos = anchorEl
    ? (() => {
        const rect = anchorEl.getBoundingClientRect();
        return {
          left: rect.left + 40,
          top: rect.top - 50* (commands.length + matchingPresets.length) - 100,
        };
      })()
    : { left: 0, top: 0 };

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
            left: (menuPos.left || 0) + 268,
            top: (menuPos.top || 0) + commands.indexOf(activeParent) * 48 + 32,
          }}
        >
          {activeParent.children?.map((child) => (
            <div
              key={child.id}
              className={`slash-command-item has-trigger${hoveredItemId === activeParent.id && activeParent.children?.[0]?.id === child.id ? ' active' : ''}`}
              data-subitem-id={child.id}
              onClick={() => handleItemSelect(child)}
              onMouseEnter={() => setHoveredItemId(activeParent.id)}
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
