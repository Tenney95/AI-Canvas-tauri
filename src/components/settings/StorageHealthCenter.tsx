/**
 * StorageHealthCenter — 存储健康中心 UI
 * 展示项目空间占用、.trash 残留、孤儿文件、重复文件，提供清理操作
 * 包含 SVG 圆环图和条状图
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import {
  scanStorageHealth,
  clearTrashDir,
  deleteOrphanFile,
  deleteDuplicateFile,
  collectNodeFilePaths,
  type StorageHealthReport,
  type TrashInfo,
  type OrphanFileInfo,
  type DuplicateFileGroup,
} from '../../services/fs/storageHealth';
import {
  estimateBrowserStorage,
  formatBytes,
  STORAGE_PRESSURE_RATIO,
  type StorageEstimate,
} from '../../services/storageQuota';
import AnimatedButton from '../shared/AnimatedButton';
import { useT } from '../../i18n';

// ============================================
// 颜色映射
// ============================================

const CATEGORY_COLORS: Record<string, string> = {
  '图片': '#34d399',
  '视频': '#60a5fa',
  '音频': '#fbbf24',
  '文本': '#a78bfa',
  '其他': '#94a3b8',
};

const PROJECT_COLORS = [
  '#6366f1', '#22d3ee', '#34d399', '#f472b6', '#fbbf24',
  '#a78bfa', '#fb923c', '#38bdf8', '#4ade80', '#facc15',
];

// ============================================
// 工具函数
// ============================================

function formatShortPath(filePath: string, maxLen = 42): string {
  if (filePath.length <= maxLen) return filePath;
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.length <= 2) return filePath;
  const first = parts.slice(0, 1).join('/');
  const last = parts.slice(-2).join('/');
  const short = `${first}/.../${last}`;
  return short.length > maxLen ? `${first}/.../${parts[parts.length - 1]}` : short;
}

// ============================================
// ECharts 风格 SVG 圆环图
// ============================================

interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

/** 极坐标 → 笛卡尔坐标 */
function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** 生成单个扇叶的 SVG path：四角圆角 + 段间白色间隙 */
function buildDonutPath(
  cx: number, cy: number,
  innerR: number, outerR: number,
  startAngle: number, endAngle: number,
  cr: number,
  gapDeg: number,
): string {
  const sa = startAngle + gapDeg / 2;
  const ea = endAngle - gapDeg / 2;
  const sweep = ea - sa;
  if (sweep <= 0) return '';

  const largeArc = sweep > 180 ? 1 : 0;

  // 小扇区需要同步收窄圆角，避免圆角互相穿插。
  const sweepRad = sweep * (Math.PI / 180);
  const cornerR = Math.min(cr, (outerR - innerR) / 2, (innerR * sweepRad) / 2);
  const outDeg = (cornerR / outerR) * (180 / Math.PI);
  const inDeg = (cornerR / innerR) * (180 / Math.PI);

  const oStart = polarToCartesian(cx, cy, outerR, sa + outDeg);
  const oEnd = polarToCartesian(cx, cy, outerR, ea - outDeg);
  const oEndCorner = polarToCartesian(cx, cy, outerR, ea);
  const oEndSide = polarToCartesian(cx, cy, outerR - cornerR, ea);
  const iEndSide = polarToCartesian(cx, cy, innerR + cornerR, ea);
  const iEndCorner = polarToCartesian(cx, cy, innerR, ea);
  const iEnd = polarToCartesian(cx, cy, innerR, ea - inDeg);
  const iStart = polarToCartesian(cx, cy, innerR, sa + inDeg);
  const iStartCorner = polarToCartesian(cx, cy, innerR, sa);
  const iStartSide = polarToCartesian(cx, cy, innerR + cornerR, sa);
  const oStartSide = polarToCartesian(cx, cy, outerR - cornerR, sa);
  const oStartCorner = polarToCartesian(cx, cy, outerR, sa);

  return [
    `M ${oStart.x} ${oStart.y}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${oEnd.x} ${oEnd.y}`,
    `Q ${oEndCorner.x} ${oEndCorner.y} ${oEndSide.x} ${oEndSide.y}`,
    `L ${iEndSide.x} ${iEndSide.y}`,
    `Q ${iEndCorner.x} ${iEndCorner.y} ${iEnd.x} ${iEnd.y}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${iStart.x} ${iStart.y}`,
    `Q ${iStartCorner.x} ${iStartCorner.y} ${iStartSide.x} ${iStartSide.y}`,
    `L ${oStartSide.x} ${oStartSide.y}`,
    `Q ${oStartCorner.x} ${oStartCorner.y} ${oStart.x} ${oStart.y}`,
    'Z',
  ].join(' ');
}

function DonutChart({ segments, total, size = 160 }: {
  segments: DonutSegment[];
  total: number;
  size?: number;
}) {
  const t = useT();
  const cx = size / 2;
  const cy = size / 2;
  const innerR = size * 0.27;
  const outerR = size * 0.46;
  const cornerR = size * 0.02;
  const gapDeg = 2;
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (segments.length === 0 || total === 0) {
    return (
      <div className="flex flex-col items-center gap-3">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={cx} cy={cy} r={outerR} fill="none" stroke="#1a1a26" strokeWidth={outerR - innerR} />
          <text x={cx} y={cy} textAnchor="middle" fill="#e8e8ed" fontSize="13" fontWeight="600">0 B</text>
        </svg>
        <div className="text-[11px] text-canvas-text-muted">{t('暂无数据')}</div>
      </div>
    );
  }

  // 计算每个扇叶的角度范围（用循环累加，不在 map 回调里改写外层变量）
  let cursor = 0;
  const slices = [];
  for (const seg of segments) {
    const sweep = (seg.value / total) * 360;
    slices.push({ ...seg, start: cursor, sweep, pct: (seg.value / total) * 100 });
    cursor += sweep;
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {/* 图例 — 居中放在顶部 */}
      <div className="flex flex-wrap justify-center gap-x-3 gap-y-1">
        {slices.map((s, i) => (
          <div
            key={i}
            className="flex items-center gap-1.5 text-[11px] cursor-default"
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: s.color }} />
            <span className="text-canvas-text-secondary">{t(s.label)}</span>
          </div>
        ))}
      </div>

      {/* 圆环 */}
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {slices.map((s, i) => (
          <path
            key={i}
            d={buildDonutPath(cx, cy, innerR, outerR, s.start, s.start + s.sweep, cornerR, gapDeg)}
            fill={s.color}
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
            style={{
              cursor: 'pointer',
              opacity: hoverIdx === null || hoverIdx === i ? 0.92 : 0.4,
              transition: 'opacity 0.2s ease',
              filter: hoverIdx === i ? 'drop-shadow(0 0 3px rgba(0,0,0,0.3))' : undefined,
            }}
          />
        ))}
        {/* 中心文字 */}
        {hoverIdx !== null ? (
          <>
            <text x={cx} y={cy - 12} textAnchor="middle" fill="#e8e8ed" fontSize="20" fontWeight="bold">
              {slices[hoverIdx].pct.toFixed(0)}%
            </text>
            <text x={cx} y={cy + 8} textAnchor="middle" fill="#e8e8ed" fontSize="15" fontWeight="600">
              {formatBytes(slices[hoverIdx].value)}
            </text>
          </>
        ) : (
          <>
            <text x={cx} y={cy - 4} textAnchor="middle" dominantBaseline="middle"
              fill="#e8e8ed" fontSize="15" fontWeight="600">
              {formatBytes(total).split(' ')[0]}
            </text>
            <text x={cx} y={cy + 13} textAnchor="middle" dominantBaseline="middle"
              fill="#8888a0" fontSize="11">
              / {formatBytes(total).split(' ')[1] || 'B'}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}

// ============================================
// SVG 条状图 (Bar Chart) 组件
// ============================================

interface BarItem {
  label: string;
  value: number;
  color: string;
}

function StackedBar({ items }: { items: BarItem[] }) {
  const t = useT();
  const total = items.reduce((s, i) => s + i.value, 0);

  if (items.length === 0 || total === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-xs text-canvas-text-muted">
        {t('暂无项目数据')}
      </div>
    );
  }

  // 过滤掉占比小于 2% 的段，防止标签重叠
  const segments = items.map((item) => ({
    ...item,
    pct: (item.value / total) * 100,
  }));

  return (
    <div className="space-y-3">
      {/* 占比条 */}
      <div className="flex h-6 rounded-lg overflow-hidden bg-canvas-surface border border-canvas-border">
        {segments.map((seg, i) => {
          const isFirst = i === 0;
          const isLast = i === segments.length - 1;
          return (
            <div
              key={i}
              className="h-full transition-[width] duration-500 ease-out motion-reduce:transition-none relative group min-w-[3px]"
              style={{
                width: `${seg.pct}%`,
                backgroundColor: seg.color,
                opacity: 0.88,
                borderRadius: isFirst
                  ? '7px 0 0 7px'
                  : isLast
                    ? '0 7px 7px 0'
                    : undefined,
              }}
              title={`${t(seg.label)}: ${formatBytes(seg.value)} (${seg.pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>

      {/* 图例 */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((seg, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[11px]">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: seg.color }} />
            <span className="text-canvas-text-secondary truncate max-w-[80px]" title={t(seg.label)}>{t(seg.label)}</span>
            <span className="text-canvas-text-muted tabular-nums">{seg.pct.toFixed(0)}%</span>
            <span className="text-canvas-text-muted tabular-nums">{formatBytes(seg.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================
// 主组件
// ============================================

export default function StorageHealthCenter() {
  const t = useT();
  const { projects, nodes, showToast } = useAppStore(
    useShallow((s) => ({
      projects: s.projects,
      currentProjectId: s.currentProjectId,
      nodes: s.nodes,
      showToast: s.showToast,
    })),
  );

  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<StorageHealthReport | null>(null);
  const [browserStorage, setBrowserStorage] = useState<StorageEstimate | null>(null);
  const [activeSection, setActiveSection] = useState<string>('overview');
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const scannedRef = useRef(false);

  // 执行扫描
  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      // 浏览器配额（IndexedDB 里的画布数据）和磁盘占用是两笔账，都要看
      void estimateBrowserStorage().then(setBrowserStorage);

      // 收集所有节点的 filePath 引用
      const nodeFilePaths = collectNodeFilePaths(nodes as Array<{ data?: Record<string, unknown> }>);
      const assetFolders = [] as { path: string; label: string }[];

      const result = await scanStorageHealth(projects, nodeFilePaths, assetFolders);
      setReport(result);
      scannedRef.current = true;

      const totalLabel = formatBytes(result.totalSize);
      const reclaimLabel = formatBytes(result.reclaimableSize);
      const issueCount =
        result.trashes.length +
        result.orphans.length +
        result.duplicates.length +
        result.offlineFolders.length;

      if (issueCount > 0) {
        showToast(
          t('总占用 {total}，可释放 {reclaim}，发现 {count} 个问题', { total: totalLabel, reclaim: reclaimLabel, count: issueCount }),
          result.reclaimableSize > 0 ? 'info' : 'success',
        );
      } else {
        showToast(t('总占用 {total}，一切正常', { total: totalLabel }));
      }
    } catch (err) {
      console.error('Storage scan failed:', err);
      showToast(t('扫描失败，请重试'), 'error');
    } finally {
      setScanning(false);
    }
  }, [projects, nodes, showToast, t]);

  // 打开时自动扫描一次
  useEffect(() => {
    if (!scannedRef.current) {
      handleScan();
    }
    return () => { scannedRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 清空 .trash
  const handleClearTrash = useCallback(async (trash: TrashInfo) => {
    setDeleting((prev) => new Set(prev).add(trash.trashDir));
    try {
      await clearTrashDir(trash.trashDir);
      showToast(t('已清空「{name}」的回收站缓存', { name: trash.projectName }));
      // 重置扫描标记以触发重新扫描
      scannedRef.current = false;
      await handleScan();
    } catch {
      showToast(t('清理失败'), 'error');
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(trash.trashDir);
        return next;
      });
    }
  }, [showToast, handleScan, t]);

  // 删除孤儿文件
  const handleDeleteOrphan = useCallback(async (orphan: OrphanFileInfo) => {
    setDeleting((prev) => new Set(prev).add(orphan.path));
    try {
      const ok = await deleteOrphanFile(orphan.path);
      if (ok) {
        showToast(t('已删除：{name}', { name: orphan.name }));
        scannedRef.current = false;
        await handleScan();
      } else {
        showToast(t('删除失败'), 'error');
      }
    } catch {
      showToast(t('删除失败'), 'error');
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(orphan.path);
        return next;
      });
    }
  }, [showToast, handleScan, t]);

  // 删除重复文件
  const handleDeleteDuplicate = useCallback(async (file: DuplicateFileGroup['files'][0]) => {
    setDeleting((prev) => new Set(prev).add(file.path));
    try {
      const ok = await deleteDuplicateFile(file.path);
      if (ok) {
        showToast(t('已删除：{name}', { name: file.name }));
        scannedRef.current = false;
        await handleScan();
      } else {
        showToast(t('删除失败'), 'error');
      }
    } catch {
      showToast(t('删除失败'), 'error');
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(file.path);
        return next;
      });
    }
  }, [showToast, handleScan, t]);

  // 清空所有 .trash
  const handleClearAllTrash = useCallback(async () => {
    if (!report) return;
    for (const trash of report.trashes) {
      await clearTrashDir(trash.trashDir);
    }
    showToast(t('已清空所有回收站缓存'));
    scannedRef.current = false;
    await handleScan();
  }, [report, showToast, handleScan, t]);

  // 删除所有孤儿文件
  const handleDeleteAllOrphans = useCallback(async () => {
    if (!report) return;
    let count = 0;
    for (const orphan of report.orphans) {
      const ok = await deleteOrphanFile(orphan.path);
      if (ok) count++;
    }
    showToast(t('已删除 {count} 个孤儿文件', { count }));
    scannedRef.current = false;
    await handleScan();
  }, [report, showToast, handleScan, t]);

  // 汇总数据
  const overview = useMemo(() => {
    if (!report) return null;

    const categoryTotals: Record<string, number> = {};
    for (const p of report.projects) {
      for (const [cat, info] of Object.entries(p.categories)) {
        categoryTotals[cat] = (categoryTotals[cat] || 0) + info.size;
      }
    }

    const donutSegments: DonutSegment[] = Object.entries(categoryTotals)
      .map(([cat, size]) => ({
        label: cat,
        value: size,
        color: CATEGORY_COLORS[cat] || '#94a3b8',
      }))
      .sort((a, b) => b.value - a.value);

    const projectBars: BarItem[] = report.projects
      .map((p, i) => ({
        label: p.projectName,
        value: p.fileSize,
        color: PROJECT_COLORS[i % PROJECT_COLORS.length],
      }))
      .sort((a, b) => b.value - a.value);

    const issueSections = [
      {
        id: 'trash',
        label: t('回收站残留'),
        count: report.trashes.length,
        totalSize: report.trashes.reduce((s, t) => s + t.trashSize, 0),
        color: '#fbbf24',
      },
      {
        id: 'orphans',
        label: t('孤儿文件'),
        count: report.orphans.length,
        totalSize: report.orphans.reduce((s, o) => s + o.size, 0),
        color: '#f472b6',
      },
      {
        id: 'duplicates',
        label: t('重复文件'),
        count: report.duplicates.length,
        totalSize: report.duplicates.reduce((s, d) => s + d.reclaimableSize, 0),
        color: '#fb923c',
      },
      {
        id: 'offline',
        label: t('离线文件夹'),
        count: report.offlineFolders.length,
        totalSize: 0,
        color: '#ef4444',
      },
    ].filter((s) => s.count > 0);

    return { donutSegments, projectBars, issueSections };
  }, [report, t]);

  const isEmpty = !report || (report.projects.length === 0 && report.trashes.length === 0);

  return (
    <div className="space-y-5">
      {/* 标题栏 + 扫描按钮 */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-canvas-text">{t('存储健康中心')}</h3>
          <p className="text-[11px] text-canvas-text-muted mt-0.5">
            {t('检测各项目的存储占用与可优化空间')}
          </p>
        </div>
        <AnimatedButton
          type="button"
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25 transition-colors"
          onClick={handleScan}
          disabled={scanning}
        >
          {scanning ? (
            <>
              <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
              </svg>
              {t('扫描中…')}
            </>
          ) : (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
              </svg>
              {t('重新扫描')}
            </>
          )}
        </AnimatedButton>
      </div>

      {/* 浏览器存储配额 — 画布数据存在 IndexedDB 里，配额用尽会导致自动保存失败 */}
      {browserStorage && browserStorage.quota > 0 && (() => {
        const ratio = Math.min(1, browserStorage.ratio);
        const pressured = ratio >= STORAGE_PRESSURE_RATIO;
        return (
          <div className={`rounded-[10px] p-3 border ${pressured ? 'border-amber-500/40 bg-amber-500/10' : 'border-canvas-border bg-canvas-card'}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium text-canvas-text">{t('浏览器存储配额')}</div>
              <div className="text-[11px] text-canvas-text-secondary">
                {formatBytes(browserStorage.usage)} / {formatBytes(browserStorage.quota)}（{(ratio * 100).toFixed(1)}%）
              </div>
            </div>
            <div className="h-2 rounded-full bg-canvas-hover overflow-hidden">
              <div
                className={`h-full rounded-full transition-[width] ${pressured ? 'bg-amber-400' : 'bg-indigo-400'}`}
                style={{ width: `${Math.max(2, ratio * 100)}%` }}
              />
            </div>
            <p className="text-[11px] text-canvas-text-muted mt-1.5">
              {pressured
                ? t('配额即将用尽，自动保存可能失败，建议清理下方可释放空间或导出并删除旧项目')
                : t('项目画布数据存放在浏览器存储中，配额用尽会导致自动保存失败')}
            </p>
          </div>
        );
      })()}

      {scanning && !report && (
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <svg className="animate-spin text-indigo-400" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
          </svg>
          <p className="text-xs text-canvas-text-secondary">{t('正在分析存储状况…')}</p>
        </div>
      )}

      {report && !isEmpty && overview && (
        <div className="space-y-5">
          {/* 总览卡片 */}
          <div className="bg-canvas-card border border-canvas-border rounded-[10px] p-3">
            <div className="flex items-center gap-6">
              {/* 圆环图 */}
              <DonutChart
                segments={overview.donutSegments}
                total={report.totalSize}
                size={160}
              />

              {/* 右侧统计 */}
              <div className="flex-1 space-y-2.5">
                <div>
                  <div className="text-[11px] text-canvas-text-muted mb-0.5">{t('总占用空间')}</div>
                  <div className="text-lg font-semibold text-canvas-text">{formatBytes(report.totalSize)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-canvas-text-muted mb-0.5">{t('可释放空间')}</div>
                  <div className={`text-lg font-semibold ${report.reclaimableSize > 0 ? 'text-emerald-400' : 'text-canvas-text'}`}>
                    {formatBytes(report.reclaimableSize)}
                  </div>
                </div>
                <div className="flex gap-3 text-[11px] text-canvas-text-muted">
                  <span>{t('{count} 个项目', { count: report.projects.length })}</span>
                  <span>{t('{count} 个文件', { count: report.projects.reduce((s, p) => s + p.fileCount, 0) })}</span>
                </div>
                {/* 问题标签 */}
                {overview.issueSections.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {overview.issueSections.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setActiveSection(s.id)}
                        className={`storage-health-selection inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-[color,background-color,box-shadow]
                          ${activeSection === s.id
                            ? 'is-active'
                            : 'bg-canvas-hover text-canvas-text-secondary hover:text-canvas-text'
                          }`}
                      >
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: s.color }} />
                        {s.label}
                        <span className="opacity-60">{s.count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 条状图 — 各项目存储占用 */}
          <div className="bg-canvas-card border border-canvas-border rounded-[10px] p-3">
            <h4 className="text-sm font-medium text-canvas-text mb-4">{t('各项目占用空间')}</h4>
            <StackedBar items={overview.projectBars} />
          </div>

          {/* 详情区域切换按钮 */}
          <div className="flex gap-1.5 border-b border-canvas-border pb-1">
            {[
              { id: 'overview', label: t('概览') },
              { id: 'trash', label: `${t('回收站残留')} ${report.trashes.length > 0 ? `(${report.trashes.length})` : ''}` },
              { id: 'orphans', label: `${t('孤儿文件')} ${report.orphans.length > 0 ? `(${report.orphans.length})` : ''}` },
              { id: 'duplicates', label: `${t('重复文件')} ${report.duplicates.length > 0 ? `(${report.duplicates.length})` : ''}` },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`storage-health-selection px-3 py-1.5 text-xs rounded-md transition-[color,background-color,box-shadow] ${
                  activeSection === tab.id
                    ? 'is-active font-medium'
                    : 'text-canvas-text-secondary hover:text-canvas-text hover:bg-canvas-hover'
                }`}
                onClick={() => setActiveSection(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* === 概览详情 === */}
          {activeSection === 'overview' && (
            <div className="space-y-3">
              {report.projects.map((p) => (
                <div key={p.projectId} className="bg-canvas-hover rounded-lg p-3 border border-canvas-border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-canvas-text">{p.projectName}</span>
                    <span className="text-[11px] text-canvas-text-secondary">{formatBytes(p.fileSize)}</span>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {Object.entries(p.categories).map(([cat, info]) => (
                      <span
                        key={cat}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-canvas-surface text-canvas-text-secondary"
                      >
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[cat] || '#94a3b8' }} />
                        {t(cat)} {info.count}{t('个')} · {formatBytes(info.size)}
                      </span>
                    ))}
                    {Object.keys(p.categories).length === 0 && (
                      <span className="text-[10px] text-canvas-text-muted">{t('暂无文件')}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* === .trash 残留 === */}
          {activeSection === 'trash' && (
            <div className="space-y-3">
              {report.trashes.length === 0 ? (
                <div className="text-center py-4 text-xs text-canvas-text-muted">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-2 opacity-40">
                    <path d="M9 9l6 6m0-6l-6 6m-7 3h20L19 4H5L2 18z" />
                  </svg>
                  {t('没有发现回收站残留，很好！')}
                </div>
              ) : (
                <>
                  <div className="flex justify-end">
                    <AnimatedButton
                      type="button"
                      className="text-[11px] text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-400/10 transition-colors"
                      onClick={handleClearAllTrash}
                    >
                      {t('清空全部')}
                    </AnimatedButton>
                  </div>
                  {report.trashes.map((trash) => (
                    <div key={trash.trashDir} className="bg-canvas-hover rounded-lg p-3 border border-canvas-border">
                      <div className="flex items-center justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-canvas-text">{trash.projectName}</div>
                          <div className="text-[10px] text-canvas-text-secondary truncate mt-0.5" title={trash.trashDir}>
                            {formatShortPath(trash.trashDir)}
                          </div>
                          <div className="text-[11px] text-amber-400 mt-1">
                            {formatBytes(trash.trashSize)} · {t('{count} 个文件', { count: trash.fileCount })}
                          </div>
                        </div>
                        <AnimatedButton
                          type="button"
                          className="shrink-0 ml-3 text-[11px] text-red-400 hover:text-red-300 px-2.5 py-1.5 rounded hover:bg-red-400/10 transition-colors"
                          onClick={() => handleClearTrash(trash)}
                          disabled={deleting.has(trash.trashDir)}
                        >
                          {deleting.has(trash.trashDir) ? t('清理中…') : t('清空')}
                        </AnimatedButton>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {/* === 孤儿文件 === */}
          {activeSection === 'orphans' && (
            <div className="space-y-3">
              {report.orphans.length === 0 ? (
                <div className="text-center py-4 text-xs text-canvas-text-muted">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-2 opacity-40">
                    <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  {t('没有发现孤儿文件，所有文件均有引用')}
                </div>
              ) : (
                <>
                  <div className="flex justify-between text-[11px] text-canvas-text-muted mb-1">
                    <span>{t('共 {count} 个孤儿文件，可释放 {size}', { count: report.orphans.length, size: formatBytes(report.orphans.reduce((s, o) => s + o.size, 0)) })}</span>
                    <AnimatedButton
                      type="button"
                      className="text-red-400 hover:text-red-300 px-2 py-0.5 rounded hover:bg-red-400/10 transition-colors"
                      onClick={handleDeleteAllOrphans}
                    >
                      {t('全部清理')}
                    </AnimatedButton>
                  </div>
                  <div className="max-h-[300px] overflow-y-auto space-y-1.5">
                    {report.orphans.map((orphan) => (
                      <div key={orphan.path} className="flex items-center justify-between bg-canvas-hover rounded-lg px-3 py-2 border border-canvas-border group">
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] text-canvas-text truncate" title={orphan.path}>
                            {orphan.name}
                          </div>
                          <div className="text-[10px] text-canvas-text-muted mt-0.5">
                            {orphan.projectName} · {formatBytes(orphan.size)}
                          </div>
                        </div>
                        <AnimatedButton
                          type="button"
                          className="shrink-0 ml-2 text-[10px] text-canvas-text-muted hover:text-red-400 px-2 py-1 rounded hover:bg-red-400/10 transition-colors opacity-0 group-hover:opacity-100"
                          onClick={() => handleDeleteOrphan(orphan)}
                          disabled={deleting.has(orphan.path)}
                        >
                          {deleting.has(orphan.path) ? '…' : t('删除')}
                        </AnimatedButton>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* === 重复文件 === */}
          {activeSection === 'duplicates' && (
            <div className="space-y-3">
              {report.duplicates.length === 0 ? (
                <div className="text-center py-4 text-xs text-canvas-text-muted">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-2 opacity-40">
                    <rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
                  </svg>
                  {t('没有发现重复文件')}
                </div>
              ) : (
                <div className="max-h-[300px] overflow-y-auto space-y-2">
                  {report.duplicates.map((group) => (
                    <div key={group.key} className="bg-canvas-hover rounded-lg p-3 border border-canvas-border">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[11px] font-medium text-canvas-text truncate max-w-[280px]" title={group.files[0]?.name}>
                          {group.files[0]?.name || t('未知文件')}
                        </div>
                        <span className="text-[10px] text-orange-400 shrink-0 ml-2">
                          {t('{count} 份 · 可释放 {size}', { count: group.files.length, size: formatBytes(group.reclaimableSize) })}
                        </span>
                      </div>
                      <div className="space-y-1">
                        {group.files.map((file, fi) => (
                          <div key={file.path} className="flex items-center justify-between text-[10px] pl-2 border-l-2 border-canvas-border">
                            <span className="text-canvas-text-secondary truncate min-w-0 flex-1" title={file.path}>
                              {file.projectName} / {file.name}
                            </span>
                            <span className="text-canvas-text-muted shrink-0 ml-2">{formatBytes(file.size)}</span>
                            {fi > 0 && (
                              <AnimatedButton
                                type="button"
                                className="shrink-0 ml-2 text-[10px] text-canvas-text-muted hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-red-400/10 transition-colors"
                                onClick={() => handleDeleteDuplicate(file)}
                                disabled={deleting.has(file.path)}
                              >
                                {deleting.has(file.path) ? '…' : t('删除')}
                              </AnimatedButton>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {report && isEmpty && (
        <div className="text-center py-6">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-3 text-canvas-text-muted opacity-40">
            <path d="M4 19.5A2.5 2.5 0 016.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
          </svg>
          <p className="text-sm text-canvas-text-secondary mb-1">{t('暂无存储数据')}</p>
          <p className="text-[11px] text-canvas-text-muted mb-4">{t('尚未创建项目或项目目录为空')}</p>
          <AnimatedButton
            type="button"
            className="text-xs px-3 py-1.5 rounded-lg bg-canvas-hover text-canvas-text-secondary hover:text-canvas-text transition-colors"
            onClick={handleScan}
          >
            {t('重新扫描')}
          </AnimatedButton>
        </div>
      )}
    </div>
  );
}
