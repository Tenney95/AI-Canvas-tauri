/**
 * SPDX-License-Identifier: Apache-2.0
 * Derived from XiaoLuo-Panorama, commit c743a39041b8049e1edfa3041311ab996aa1ff8f.
 * Modified for AI Canvas: local types, host styles and lifecycle integration.
 * License: public/licenses/XiaoLuo-Panorama-LICENSE.txt
 */

import type React from 'react';

export interface PanoramaViewState {
  pitch: number;
  yaw: number;
  hfov: number;
}

export interface PanoramaCoreHandle {
  captureScreenshot: () => string | null;
  focus: () => void;
  getView: () => PanoramaViewState | null;
  reset: (animated?: boolean | number) => void;
  resize: () => void;
  setView: (view: Partial<PanoramaViewState>, animated?: boolean | number) => void;
}

export interface PanoramaCoreProps {
  imageUrl: string;
  className?: string;
  style?: React.CSSProperties;
  initialPitch?: number;
  initialYaw?: number;
  initialHfov?: number;
  minHfov?: number;
  maxHfov?: number;
  draggable?: boolean;
  mouseZoom?: boolean;
  keyboardZoom?: boolean;
  autoLoad?: boolean;
  backgroundColor?: [number, number, number];
  crossOrigin?: 'anonymous' | 'use-credentials';
  onLoad?: () => void;
  onError?: (message: string) => void;
  onReady?: (handle: PanoramaCoreHandle) => void;
  onViewChange?: (view: PanoramaViewState) => void;
}

export interface PanoramaViewerProps {
  imageUrl: string;
  onClose: () => void;
  closeText?: string;
  theme?: 'light' | 'dark';
  cornerRadius?: React.CSSProperties['borderRadius'];
  captureMode?: 'instant' | 'ratio';
  onCapture?: (capture: PanoramaCaptureResult) => void | Promise<void>;
  className?: string;
  style?: React.CSSProperties;
}

export interface PanoramaCaptureResult {
  dataUrl: string;
  kind: 'viewport' | 'architectural';
  aspectRatio?: PanoramaCaptureRatio;
}

export type PanoramaCaptureRatio =
  | 'auto'
  | '1:1'
  | '9:16'
  | '16:9'
  | '3:4'
  | '4:3'
  | '3:2'
  | '2:3'
  | '5:4'
  | '4:5'
  | '21:9'
  | '1:4'
  | '4:1';
