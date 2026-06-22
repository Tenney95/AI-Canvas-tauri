/**
 * AssetThumb — 资产缩略图外壳（AssetsPanel / AssetSearchWindow 卡片共用）
 * 统一图片/图标展示 + 体积角标 + 来源角标 + 操作按钮插槽，消除两处卡片的视觉重复。
 */
import type { ReactNode } from 'react';
import type { FileCategory } from '../../services/fileService';
import { CATEGORY_ICONS, formatSize } from '../../utils/assetFormat';

interface AssetThumbProps {
  assetUrl?: string;
  name: string;
  category: FileCategory;
  size: number;
  /** 右上角来源/标记角标文字（如「外部」「全局」「项目名」），为空不显示 */
  badge?: string;
  /** 悬停操作按钮区 */
  children?: ReactNode;
}

export default function AssetThumb({ assetUrl, name, category, size, badge, children }: AssetThumbProps) {
  return assetUrl ? (
    <div className="assets-card-img-wrap">
      <img src={assetUrl} alt={name} className="assets-card-img" loading="lazy" decoding="async" draggable={false} />
      <span className="assets-card-size">{formatSize(size)}</span>
      {badge && <span className="assets-card-badge">{badge}</span>}
      {children}
    </div>
  ) : (
    <div className="assets-card-icon-wrap">
      <span className="assets-card-icon">{CATEGORY_ICONS[category]}</span>
      <span className="assets-card-size">{formatSize(size)}</span>
      {badge && <span className="assets-card-badge">{badge}</span>}
      {children}
    </div>
  );
}
