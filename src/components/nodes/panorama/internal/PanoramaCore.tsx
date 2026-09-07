/**
 * SPDX-License-Identifier: Apache-2.0
 * Derived from XiaoLuo-Panorama, commit c743a39041b8049e1edfa3041311ab996aa1ff8f.
 * Modified for AI Canvas: local types, host styles and lifecycle integration.
 * License: public/licenses/XiaoLuo-Panorama-LICENSE.txt
 */

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import 'pannellum';
import type { PanoramaViewState, PanoramaCoreHandle, PanoramaCoreProps } from '../../../../types/panorama';

interface PannellumRenderer {
  render: (
    pitch: number,
    yaw: number,
    hfov: number,
    params: { returnImage: boolean },
  ) => string | undefined;
}

interface PannellumViewer {
  destroy: () => void;
  getHfov: () => number;
  getPitch: () => number;
  getRenderer: () => PannellumRenderer;
  getYaw: () => number;
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  resize: () => void;
  setHfov: (hfov: number, animated?: boolean | number) => void;
  setPitch: (pitch: number, animated?: boolean | number) => void;
  setYaw: (yaw: number, animated?: boolean | number) => void;
}

interface PannellumGlobal {
  viewer: (container: HTMLElement, config: Record<string, unknown>) => PannellumViewer;
}

const toRadians = (degrees: number) => degrees * Math.PI / 180;
const DEFAULT_BACKGROUND_COLOR: [number, number, number] = [243, 244, 246];

export const PanoramaCore: React.ForwardRefExoticComponent<
  PanoramaCoreProps & React.RefAttributes<PanoramaCoreHandle>
> = forwardRef<PanoramaCoreHandle, PanoramaCoreProps>(
  function PanoramaCore({
    imageUrl,
    className = '',
    style,
    initialPitch = 0,
    initialYaw = 180,
    initialHfov = 110,
    minHfov = 40,
    maxHfov = 150,
    draggable = true,
    mouseZoom = true,
    keyboardZoom = true,
    autoLoad = true,
    backgroundColor = DEFAULT_BACKGROUND_COLOR,
    crossOrigin = 'anonymous',
    onLoad,
    onError,
    onReady,
    onViewChange,
  }, forwardedRef) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewerRef = useRef<PannellumViewer | null>(null);
    const callbacksRef = useRef({ onLoad, onError, onReady, onViewChange });
    const initialViewRef = useRef<PanoramaViewState>({
      pitch: initialPitch,
      yaw: initialYaw,
      hfov: initialHfov,
    });

    useLayoutEffect(() => {
      callbacksRef.current = { onLoad, onError, onReady, onViewChange };
    });

    const handleRef = useRef<PanoramaCoreHandle>({
      captureScreenshot() {
        const viewer = viewerRef.current;
        if (!viewer) return null;

        try {
          const view = {
            pitch: viewer.getPitch(),
            yaw: viewer.getYaw(),
            hfov: viewer.getHfov(),
          };
          return viewer.getRenderer().render(
            toRadians(view.pitch),
            toRadians(view.yaw),
            toRadians(view.hfov),
            { returnImage: true },
          ) ?? null;
        } catch {
          return null;
        }
      },
      focus() {
        containerRef.current?.focus({ preventScroll: true });
      },
      getView() {
        const viewer = viewerRef.current;
        return viewer ? {
          pitch: viewer.getPitch(),
          yaw: viewer.getYaw(),
          hfov: viewer.getHfov(),
        } : null;
      },
      reset(animated = false) {
        const viewer = viewerRef.current;
        if (!viewer) return;
        const initialView = initialViewRef.current;
        viewer.setPitch(initialView.pitch, animated);
        viewer.setYaw(initialView.yaw, animated);
        viewer.setHfov(initialView.hfov, animated);
      },
      resize() {
        viewerRef.current?.resize();
      },
      setView(view, animated = false) {
        const viewer = viewerRef.current;
        if (!viewer) return;
        if (view.pitch !== undefined) viewer.setPitch(view.pitch, animated);
        if (view.yaw !== undefined) viewer.setYaw(view.yaw, animated);
        if (view.hfov !== undefined) viewer.setHfov(view.hfov, animated);
      },
    });

    useImperativeHandle(forwardedRef, () => handleRef.current, []);

    useEffect(() => {
      const container = containerRef.current;
      if (!container || !imageUrl) return;

      const pannellum = (
        window as Window & { pannellum?: PannellumGlobal }
      ).pannellum;
      if (!pannellum) {
        callbacksRef.current.onError?.('Pannellum is unavailable');
        return;
      }

      let viewer: PannellumViewer;
      try {
        viewer = pannellum.viewer(container, {
        type: 'equirectangular',
        panorama: imageUrl,
        pitch: initialViewRef.current.pitch,
        yaw: initialViewRef.current.yaw,
        hfov: initialViewRef.current.hfov,
        autoLoad,
        showZoomCtrl: false,
        showFullscreenCtrl: false,
        backgroundColor,
        compass: false,
        keyboardZoom,
        mouseZoom,
        draggable,
        minHfov,
        maxHfov,
        hfovBounds: [minHfov, maxHfov],
        friction: 0.15,
        multiRes: false,
        crossOrigin,
        });
      } catch {
        callbacksRef.current.onError?.('无法初始化全景渲染器，请检查 WebGL 支持后重试');
        return;
      }
      viewerRef.current = viewer;
      let active = true;

      const emitView = () => {
        if (!active) return;
        callbacksRef.current.onViewChange?.({
          pitch: viewer.getPitch(),
          yaw: viewer.getYaw(),
          hfov: viewer.getHfov(),
        });
      };

      viewer.on('load', () => { if (active) callbacksRef.current.onLoad?.(); });
      viewer.on('error', (error) => {
        if (!active) return;
        callbacksRef.current.onError?.(
          typeof error === 'string' ? error : 'Failed to load panorama',
        );
      });
      viewer.on('viewchange', emitView);
      viewer.on('zoomchange', emitView);
      callbacksRef.current.onReady?.(handleRef.current);

      const resizeObserver = new ResizeObserver(() => { if (active) viewer.resize(); });
      resizeObserver.observe(container);

      return () => {
        active = false;
        resizeObserver.disconnect();
        if (viewerRef.current === viewer) viewerRef.current = null;
        viewer.destroy();
      };
    }, [
      autoLoad,
      backgroundColor,
      crossOrigin,
      draggable,
      imageUrl,
      keyboardZoom,
      maxHfov,
      minHfov,
      mouseZoom,
    ]);

    return (
      <div
        ref={containerRef}
        className={`xiaoluo-panorama-core ${className}`.trim()}
        style={{ width: '100%', height: '100%', ...style }}
        data-panorama-core=""
      />
    );
  },
);
