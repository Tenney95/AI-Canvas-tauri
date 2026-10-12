/**
 * AssetThumb — 资产缩略图外壳（AssetsPanel / AssetSearchWindow 卡片共用）
 * 统一图片/图标展示 + 体积角标 + 来源角标 + 操作按钮插槽，消除两处卡片的视觉重复。
 */
import { useState, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { FileCategory } from '../../services/fileService';
import { readTextFilePreview, getCachedTextPreview, ASSET_TEXT_UPDATED_EVENT } from '../../services/fileService';
import { CATEGORY_ICONS, formatSize } from '../../utils/assetFormat';
import ViewportImage from './ViewportImage';
import ResourceVideoPreview from './ResourceVideoPreview';
import { getPerformanceModeBudget, getPerformanceModeEnabled, subscribePerformanceMode } from '../../services/performanceModeRuntime';

interface AssetThumbProps {
  assetUrl?: string;
  filePath?: string;
  videoExpanded?: boolean;
  videoPresentation?: 'inline' | 'fullscreen';
  videoProjectId?: string;
  onVideoExpandedChange?: (expanded: boolean) => void;
  name: string;
  category: FileCategory;
  size: number;
  /** 右上角来源/标记角标文字（如「外部」「全局」「项目名」），为空不显示 */
  badge?: string;
  /** 悬停操作按钮区 */
  children?: ReactNode;
  onImagePreview?: () => void;
  onTextPreview?: () => void;
  /** 宿主提供完整悬浮提示时，避免同时出现浏览器原生标题。 */
  showNativeTooltip?: boolean;
  /** 外部直接注入文本预览（用于测试或已具备文本的场景） */
  textPreview?: string;
}

interface AssetTextPreviewProps {
  onTextPreview?: () => void;
  filePath?: string;
  name: string;
  size: number;
  badge?: string;
  children?: ReactNode;
  textPreview?: string;
  showNativeTooltip?: boolean;
}

export function AssetTextPreview({
  filePath,
  name,
  size,
  badge,
  children,
  textPreview: propTextPreview,
  showNativeTooltip = true,
  onTextPreview,
}: AssetTextPreviewProps) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<string>).detail === filePath) setRevision((value) => value + 1);
    };
    window.addEventListener(ASSET_TEXT_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(ASSET_TEXT_UPDATED_EVENT, refresh);
  }, [filePath]);
  const [content, setContent] = useState<string | null>(() => {
    if (propTextPreview !== undefined) return propTextPreview;
    if (filePath) return getCachedTextPreview(filePath, size) ?? null;
    return null;
  });

  useEffect(() => {
    if (propTextPreview !== undefined || !filePath) return;
    let active = true;
    readTextFilePreview(filePath, size).then((text) => {
      if (active) setContent(text);
    }).catch(() => {
      if (active) setContent('');
    });
    return () => {
      active = false;
    };
  }, [filePath, size, propTextPreview, revision]);

  const trigger = onTextPreview && <button type="button" className="asset-image-preview-trigger" aria-label={`查看文档 ${name}`}
    title={showNativeTooltip ? '查看和编辑文档' : undefined} onClick={(event) => { event.stopPropagation(); onTextPreview(); }} />;
  const effectiveText = propTextPreview !== undefined ? propTextPreview : content;

  if (effectiveText && effectiveText.trim().length > 0) {
    return (
      <div className="assets-card-text-wrap" title={showNativeTooltip ? name : undefined}>
        <div className="assets-card-text-content">{effectiveText}</div>
        <div className="assets-card-text-fade" />
        {trigger}
        <span className="assets-card-size">{formatSize(size)}</span>
        {badge && <span className="assets-card-badge">{badge}</span>}
        {children}
      </div>
    );
  }

  return (
    <div className="assets-card-icon-wrap" title={showNativeTooltip ? name : undefined}>
      <span className="assets-card-icon">{CATEGORY_ICONS.text}</span>
      {trigger}
      <span className="assets-card-size">{formatSize(size)}</span>
      {badge && <span className="assets-card-badge">{badge}</span>}
      {children}
    </div>
  );
}

export default function AssetThumb({
  assetUrl,
  filePath,
  videoExpanded = false,
  videoPresentation,
  videoProjectId,
  onVideoExpandedChange,
  name,
  category,
  size,
  badge,
  children,
  onImagePreview,
  onTextPreview,
  showNativeTooltip = true,
  textPreview,
}: AssetThumbProps) {
  const performanceMode = useSyncExternalStore(subscribePerformanceMode, getPerformanceModeEnabled, getPerformanceModeEnabled);
  const previewMaxEdge = category === 'image' ? getPerformanceModeBudget(performanceMode).imagePreviewMaxEdge : 0;
  if (category === 'video') {
    return (
      <div className="assets-card-img-wrap assets-card-video-wrap">
        <ResourceVideoPreview src={assetUrl} filePath={filePath} name={name} expanded={videoExpanded}
          presentation={videoPresentation} projectId={videoProjectId} size={size}
          onExpandedChange={(expanded) => onVideoExpandedChange?.(expanded)} />
        <span className="assets-card-size">{formatSize(size)}</span>
        {badge && <span className="assets-card-badge">{badge}</span>}
        {children}
      </div>
    );
  }

  if (category === 'text') {
    return (
      <AssetTextPreview
        filePath={filePath}
        name={name}
        size={size}
        badge={badge}
        textPreview={textPreview}
        onTextPreview={onTextPreview}
        showNativeTooltip={showNativeTooltip}
      >
        {children}
      </AssetTextPreview>
    );
  }

  if (assetUrl) {
    return (
      <div className="assets-card-img-wrap">
        <ViewportImage src={assetUrl} alt={name} className="assets-card-img" draggable={false}
          previewMaxEdge={previewMaxEdge || undefined} projectId={videoProjectId} />
        {category === 'image' && onImagePreview && (
          <button
            type="button"
            className="asset-image-preview-trigger"
            aria-label={`查看图片 ${name}`}
            title={showNativeTooltip ? '查看大图和生成信息' : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onImagePreview();
            }}
          />
        )}
        <span className="assets-card-size">{formatSize(size)}</span>
        {badge && <span className="assets-card-badge">{badge}</span>}
        {children}
      </div>
    );
  }

  return (
    <div className="assets-card-icon-wrap">
      <span className="assets-card-icon">{CATEGORY_ICONS[category]}</span>
      <span className="assets-card-size">{formatSize(size)}</span>
      {badge && <span className="assets-card-badge">{badge}</span>}
      {children}
    </div>
  );
}
