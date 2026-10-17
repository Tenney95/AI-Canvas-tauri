/**
 * character/CharacterReferenceGallery — 角色参考图画廊。
 * 参考图按预览区高度等比排列为一行，超出宽度时横向滚动。
 * 支持选中、编辑与裁剪预览，并向上汇报实际图片区域尺寸。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { CharacterReferenceImage } from '../../types/dramaAssets';
import ViewportImage from '../shared/ViewportImage';
import { CHARACTER_REFERENCE_KIND_LABELS } from './characterReferencePresentation';
import AssetFileContextMenu from '../assets/AssetFileContextMenu';
import { copyFile, copyText } from '../../services/clipboardService';
import { deletePermanentFile, isTauriEnv, revealFileInFolder } from '../../services/fileService';
import { useAppStore } from '../../store/useAppStore';

const GAP = 8;

export interface ReferenceStageBox {
  width: number;
  height: number;
}

interface CharacterReferenceGalleryProps {
  references: CharacterReferenceImage[];
  selectedId: string | null;
  onSelect: (referenceId: string) => void;
  onEdit: (referenceId: string) => void;
  /** 汇报实际铺开的图片区域尺寸 */
  onStageResize?: (stage: ReferenceStageBox | null) => void;
}

export default function CharacterReferenceGallery({
  references,
  selectedId,
  onSelect,
  onEdit,
  onStageResize,
}: CharacterReferenceGalleryProps) {
  const [fileMenu, setFileMenu] = useState<{ reference: CharacterReferenceImage; x: number; y: number } | null>(null);
  const closeFileMenu = useCallback(() => setFileMenu(null), []);
  const menuReference = fileMenu && references.find((reference) => reference === fileMenu.reference);
  const showToast = useAppStore((state) => state.showToast);
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [ratios, setRatios] = useState<Record<string, number>>({});

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [references.length]);

  // 记录比例时顺手丢掉已不存在的条目：图片可能被替换，旧值会影响重新加入时的排版。
  // 放在 onLoad 里而不是 effect 里，避免多一轮级联渲染。
  const recordRatio = (referenceId: string, ratio: number) => {
    setRatios((previous) => {
      if (previous[referenceId] === ratio) return previous;
      const alive = Object.entries(previous).filter(([id]) => references.some((item) => item.id === id));
      return { ...Object.fromEntries(alive), [referenceId]: ratio };
    });
  };

  const layout = useMemo(() => {
    if (!references.length || box.width <= 0 || box.height <= 0) return null;
    // 比例未知的先按 1 排，图片加载后保持满高并按真实比例更新宽度。
    const width = references.reduce((sum, item) => sum + (ratios[item.id] ?? 1) * box.height, 0)
      + GAP * (references.length - 1);
    return {
      width,
      height: box.height,
      rows: [{ items: references.map((_, index) => index), height: box.height }],
    };
  }, [box.height, box.width, ratios, references]);

  useEffect(() => {
    onStageResize?.(layout ? { width: layout.width, height: layout.height } : null);
  }, [layout, onStageResize]);

  if (references.length === 0) {
    return (
      <div className="character-reference-empty">
        <Icon icon="lucide:images" width="30" height="30" aria-hidden="true" />
        <span>还没有参考图</span>
      </div>
    );
  }

  return (
    <>
    <div className="character-reference-grid" role="list" aria-label="角色参考图" ref={containerRef}>
      {layout?.rows.map((row, rowIndex) => (
        <div
          className="character-reference-row"
          key={row.items.join('-') || rowIndex}
          style={{ width: layout.width, height: row.height }}
        >
          {row.items.map((index) => {
            const reference = references[index];
            return (
              <button
                key={reference.id}
                type="button"
                role="listitem"
                className={`character-reference-item ${reference.id === selectedId ? 'is-selected' : ''}`}
                style={{ flex: `${ratios[reference.id] ?? 1} 1 0` }}
                onClick={() => onSelect(reference.id)}
                onDoubleClick={() => onEdit(reference.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.focus();
                  onSelect(reference.id);
                  setFileMenu({ reference, x: event.clientX, y: event.clientY });
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  onSelect(reference.id);
                  setFileMenu({ reference, x: rect.left, y: rect.top });
                }}
                aria-label={`${CHARACTER_REFERENCE_KIND_LABELS[reference.kind]}参考图`}
              >
                {reference.imageUrl ? (
                  <ViewportImage
                    src={reference.imageUrl}
                    alt=""
                    draggable={false}
                    eager={reference.id === selectedId}
                    onLoad={(event) => {
                      const { naturalWidth, naturalHeight } = event.currentTarget;
                      if (!naturalWidth || !naturalHeight) return;
                      recordRatio(reference.id, naturalWidth / naturalHeight);
                    }}
                  />
                ) : (
                  <Icon icon="lucide:image-off" width="24" height="24" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
    {fileMenu && menuReference && <AssetFileContextMenu
      key={`${menuReference.id}:${fileMenu.x}:${fileMenu.y}`}
      name={menuReference.filePath?.split(/[\\/]/).pop() || '角色参考图'}
      x={fileMenu.x}
      y={fileMenu.y}
      canFileActions={isTauriEnv() && !!menuReference.filePath}
      canCopyPrompt={!!menuReference.prompt.trim()}
      onCopy={async () => {
        if (!menuReference.filePath || !(await copyFile(menuReference.filePath))) throw new Error('复制失败');
        showToast('文件已复制，可在系统中粘贴');
      }}
      onCopyPrompt={async () => {
        if (!(await copyText(menuReference.prompt))) throw new Error('复制失败');
        showToast('提示词已复制');
      }}
      onReveal={async () => {
        if (!menuReference.filePath) throw new Error('文件不可用');
        await revealFileInFolder(menuReference.filePath);
      }}
      onDelete={async () => {
        if (!menuReference.filePath) throw new Error('文件不可用');
        await deletePermanentFile(menuReference.filePath);
        showToast('文件已移入系统回收站');
      }}
      onClose={closeFileMenu}
    />}
    </>
  );
}
