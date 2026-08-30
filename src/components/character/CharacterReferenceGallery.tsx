/**
 * character/CharacterReferenceGallery — 角色参考图画廊。
 * 用等宽排版（justifiedRows）把主视觉、头像、全身、表情、转面、服装等参考图铺成网格，
 * 支持选中、编辑与裁剪预览，并向上汇报实际铺开的图片框供浮层贴边定位。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { CharacterReferenceImage } from '../../types/dramaAssets';
import ViewportImage from '../shared/ViewportImage';
import { CHARACTER_REFERENCE_KIND_LABELS } from './characterReferencePresentation';
import { justifiedRows } from './justifiedRows';

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
  /** 汇报实际铺开的图片框；容器留白时浮层要贴图片边缘而不是容器边缘 */
  onStageResize?: (stage: ReferenceStageBox | null) => void;
}

export default function CharacterReferenceGallery({
  references,
  selectedId,
  onSelect,
  onEdit,
  onStageResize,
}: CharacterReferenceGalleryProps) {
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

  const layout = useMemo(
    // 比例未知的先按 1 排，onLoad 拿到真实尺寸后自动重排
    () => justifiedRows(references.map((item) => ratios[item.id] ?? 1), box.width, box.height, GAP),
    [box.height, box.width, ratios, references],
  );

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
  );
}
