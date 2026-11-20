/**
 * DramaAssetListControls — 提供短剧资产列表筛选界面与交互。
 */
import { ArrowDownWideNarrow, ArrowUpNarrowWide, CheckSquare, Copy, Download } from 'lucide-react';
import { useT } from '../../i18n';
import type { DramaAssetSortBy } from '../../services/dramaAssetSearch';
import Select from '../shared/Select';

export default function DramaAssetListControls({ sortBy, sortOrder, onSort, selecting, onSelecting,
  selectedCount, visibleCount, onSelectAll, onExport, onCopy, copyLabel, busy, canExport, inline = false,
}: {
  sortBy: DramaAssetSortBy; sortOrder: 'asc' | 'desc'; onSort: (by: DramaAssetSortBy, order: 'asc' | 'desc') => void;
  selecting: boolean; onSelecting?: () => void; selectedCount: number; visibleCount: number;
  onSelectAll: () => void; onExport: () => void; onCopy?: () => void; copyLabel: string; busy: boolean; canExport: boolean;
  inline?: boolean;
}) {
  const t = useT();
  const OrderIcon = sortOrder === 'asc' ? ArrowUpNarrowWide : ArrowDownWideNarrow;
  return <div className={`flex min-w-0 max-w-full flex-wrap items-center gap-1${inline ? '' : ' px-3 pb-2'}`}>
    <Select<DramaAssetSortBy> size="sm" className="w-[86px]" value={sortBy} disabled={busy}
      aria-label={t('创作资产排序方式')} onChange={(by) => onSort(by, sortOrder)}
      options={(['name', 'createdAt', 'updatedAt'] as const).map((value) => ({ value,
        label: t(value === 'name' ? '名称' : value === 'createdAt' ? '创建时间' : '更新时间') }))} />
    <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy}
      title={t(sortOrder === 'asc' ? '切换为降序' : '切换为升序')}
      onClick={() => onSort(sortBy, sortOrder === 'asc' ? 'desc' : 'asc')}>
      <OrderIcon size={14} aria-hidden="true" />{t(sortOrder === 'asc' ? '升序' : '降序')}
    </button>
    {onSelecting && <button type="button" className={`ui-btn ui-btn--ghost ui-btn--sm${selecting ? ' is-active' : ''}`}
      aria-pressed={selecting} disabled={busy} onClick={onSelecting}>
      <CheckSquare size={14} aria-hidden="true" />{t(selecting ? '退出多选' : '多选')}
    </button>}
    {onSelecting && selecting && <>
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || !visibleCount} onClick={onSelectAll}>
        {t(selectedCount === visibleCount && visibleCount > 0 ? '取消全选' : '全选')}
      </button>
      <span className="text-xs text-canvas-text-secondary" role="status">{t('已选 {count} 项', { count: selectedCount })}</span>
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || !selectedCount || !canExport} onClick={onExport}>
        <Download size={14} aria-hidden="true" />{t('导出所选')}
      </button>
      {onCopy && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || !selectedCount} onClick={onCopy}>
        <Copy size={14} aria-hidden="true" />{copyLabel}
      </button>}
    </>}
  </div>;
}
