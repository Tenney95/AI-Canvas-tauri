/**
 * 图片合成编辑器 — 图层数据模型
 *
 * 坐标/旋转/缩放沿用 Konva 约定：x/y 为图层原点（页面坐标系，像素），
 * rotation 为角度（deg），scaleX/scaleY 为缩放倍率。
 */

export type LayerType = 'image' | 'text' | 'rect' | 'ellipse' | 'line' | 'arrow';

export interface BaseLayer {
  id: string;
  type: LayerType;
  name: string;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
  visible: boolean;
}

export interface ImageLayer extends BaseLayer {
  type: 'image';
  src: string; // 安全 data: URL（已规避跨源污染）
  image: HTMLImageElement;
  width: number; // 自然像素尺寸
  height: number;
}

export interface TextLayer extends BaseLayer {
  type: 'text';
  text: string;
  fontSize: number;
  fontFamily: string;
  fontStyle: string; // 'normal' | 'bold' | 'italic' | 'italic bold'
  fill: string;
  align: 'left' | 'center' | 'right';
  width: number; // 文本框宽（自动换行）
}

export interface ShapeLayer extends BaseLayer {
  type: 'rect' | 'ellipse';
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  cornerRadius: number;
}

export interface LineLayer extends BaseLayer {
  type: 'line' | 'arrow';
  points: number[]; // 相对图层原点的折线点
  stroke: string;
  strokeWidth: number;
}

export type Layer = ImageLayer | TextLayer | ShapeLayer | LineLayer;

export type CanvasBg = 'transparent' | string; // 'transparent' 或 CSS 颜色

export interface CanvasSettings {
  width: number;
  height: number;
  bg: CanvasBg;
}
