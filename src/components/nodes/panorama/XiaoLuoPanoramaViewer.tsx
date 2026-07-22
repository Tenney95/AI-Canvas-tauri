import { Icon } from '@iconify/react';
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  PanoramaCore,
  type PanoramaCoreHandle,
  type PanoramaViewState,
} from 'xiaoluo-vr-panorama/core';
import 'xiaoluo-vr-panorama/core.css';

export interface XiaoLuoPanoramaViewerHandle {
  captureScreenshot: (aspect?: number | null) => Promise<string | null>;
}

interface XiaoLuoPanoramaViewerProps {
  imageUrl: string;
  immersive?: boolean;
}

interface WalkTransform {
  x: number;
  y: number;
  scale: number;
}

const INITIAL_VIEW: PanoramaViewState = { pitch: 0, yaw: 180, hfov: 95 };
const WALK_KEYS = new Set(['w', 'a', 's', 'd']);

function cropScreenshot(dataUrl: string, aspect?: number | null): Promise<string | null> {
  if (!aspect || aspect <= 0) return Promise.resolve(dataUrl);

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const sourceWidth = image.naturalWidth;
      const sourceHeight = image.naturalHeight;
      if (!sourceWidth || !sourceHeight) {
        resolve(null);
        return;
      }

      let cropWidth = sourceWidth;
      let cropHeight = sourceHeight;
      if (sourceWidth / sourceHeight > aspect) {
        cropWidth = Math.round(sourceHeight * aspect);
      } else {
        cropHeight = Math.round(sourceWidth / aspect);
      }

      const canvas = document.createElement('canvas');
      canvas.width = cropWidth;
      canvas.height = cropHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        resolve(null);
        return;
      }

      context.drawImage(
        image,
        Math.round((sourceWidth - cropWidth) / 2),
        Math.round((sourceHeight - cropHeight) / 2),
        cropWidth,
        cropHeight,
        0,
        0,
        cropWidth,
        cropHeight,
      );
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

const XiaoLuoPanoramaViewer = forwardRef<
  XiaoLuoPanoramaViewerHandle,
  XiaoLuoPanoramaViewerProps
>(function XiaoLuoPanoramaViewer({ imageUrl, immersive = false }, forwardedRef) {
  const coreRef = useRef<PanoramaCoreHandle>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<Record<string, boolean>>({});
  const momentumRef = useRef({ x: 0, z: 0 });
  const animationRef = useRef<number | null>(null);

  const [viewerKey, setViewerKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [walking, setWalking] = useState(false);
  const [showCorrections, setShowCorrections] = useState(false);
  const [shiftMode, setShiftMode] = useState(false);
  const [view, setView] = useState(INITIAL_VIEW);
  const [horizontalOffset, setHorizontalOffset] = useState(0);
  const [verticalOffset, setVerticalOffset] = useState(0);
  const [perspective, setPerspective] = useState(0);
  const [walkTransform, setWalkTransform] = useState<WalkTransform>({ x: 0, y: 0, scale: 1 });

  useEffect(() => {
    setLoading(true);
    setError(null);
    setWalking(false);
  }, [imageUrl]);

  useImperativeHandle(forwardedRef, () => ({
    async captureScreenshot(aspect?: number | null) {
      const dataUrl = coreRef.current?.captureScreenshot();
      if (!dataUrl) return null;
      return cropScreenshot(dataUrl, aspect);
    },
  }), []);

  useEffect(() => {
    if (!immersive || !walking) return;
    const shell = shellRef.current;
    if (!shell) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      const key = event.key.toLowerCase();
      if (!WALK_KEYS.has(key)) return;
      event.preventDefault();
      keysRef.current[key] = true;
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      keysRef.current[event.key.toLowerCase()] = false;
    };

    shell.addEventListener('keydown', handleKeyDown);
    shell.addEventListener('keyup', handleKeyUp);

    let step = 0;
    const animate = () => {
      const acceleration = 0.09;
      const friction = 0.9;
      let targetX = 0;
      let targetZ = 0;
      if (keysRef.current.w) targetZ += acceleration;
      if (keysRef.current.s) targetZ -= acceleration;
      if (keysRef.current.a) targetX -= acceleration;
      if (keysRef.current.d) targetX += acceleration;

      momentumRef.current.x = (momentumRef.current.x + targetX) * friction;
      momentumRef.current.z = (momentumRef.current.z + targetZ) * friction;
      const speed = Math.hypot(momentumRef.current.x, momentumRef.current.z);
      step += speed * 0.15;

      const currentView = coreRef.current?.getView();
      if (currentView && speed > 0.005) {
        coreRef.current?.setView({
          yaw: currentView.yaw + momentumRef.current.x * 0.18,
          hfov: Math.max(45, Math.min(125, currentView.hfov - momentumRef.current.z * 0.22)),
        });
      }

      setWalkTransform((current) => ({
        x: Math.max(-18, Math.min(18, current.x + momentumRef.current.x * 0.7)),
        y: speed > 0.02 ? Math.sin(step) * Math.min(3, speed * 1.2) : 0,
        scale: 1 + Math.max(0, momentumRef.current.z * 0.0015),
      }));
      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);
    return () => {
      shell.removeEventListener('keydown', handleKeyDown);
      shell.removeEventListener('keyup', handleKeyUp);
      keysRef.current = {};
      momentumRef.current = { x: 0, z: 0 };
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
      setWalkTransform({ x: 0, y: 0, scale: 1 });
    };
  }, [immersive, walking]);

  const toggleWalking = useCallback(() => {
    setWalking((enabled) => !enabled);
    requestAnimationFrame(() => coreRef.current?.focus());
  }, []);

  const updateHfov = useCallback((hfov: number) => {
    setView((current) => ({ ...current, hfov }));
    coreRef.current?.setView({ hfov });
  }, []);

  const toggleShiftMode = useCallback(() => {
    setShiftMode((enabled) => {
      const next = !enabled;
      if (next) coreRef.current?.setView({ pitch: 0 }, true);
      return next;
    });
  }, []);

  const resetCorrections = useCallback(() => {
    setShiftMode(false);
    setHorizontalOffset(0);
    setVerticalOffset(0);
    setPerspective(0);
    setView(INITIAL_VIEW);
    coreRef.current?.reset(true);
  }, []);

  const retry = useCallback(() => {
    setError(null);
    setLoading(true);
    setViewerKey((key) => key + 1);
  }, []);

  const transformStyle = {
    '--pano-offset-x': `${horizontalOffset + walkTransform.x}px`,
    '--pano-offset-y': `${verticalOffset + walkTransform.y}px`,
    '--pano-perspective': `${perspective}deg`,
    '--pano-walk-scale': String(walkTransform.scale),
  } as React.CSSProperties;

  return (
    <div
      ref={shellRef}
      className={`xiaoluo-pano-shell nodrag nowheel${immersive ? ' is-immersive' : ' is-compact'}${walking ? ' is-walking' : ''}`}
      data-ui-stop="1"
    >
      <div className="xiaoluo-pano-transform" style={transformStyle}>
        <PanoramaCore
          key={viewerKey}
          ref={coreRef}
          imageUrl={imageUrl}
          initialPitch={INITIAL_VIEW.pitch}
          initialYaw={INITIAL_VIEW.yaw}
          initialHfov={INITIAL_VIEW.hfov}
          keyboardZoom={immersive}
          onLoad={() => {
            setLoading(false);
            setError(null);
          }}
          onError={(message) => {
            setLoading(false);
            setError(message || '无法加载全景图');
          }}
          onViewChange={(nextView) => {
            if (shiftMode && Math.abs(nextView.pitch) > 0.1) {
              coreRef.current?.setView({ pitch: 0 });
              setView({ ...nextView, pitch: 0 });
              return;
            }
            setView(nextView);
          }}
        />
      </div>

      {loading && (
        <div className="xiaoluo-pano-status" role="status">
          <span className="spinner" />
          <span>{immersive ? '正在载入全景空间...' : '载入中...'}</span>
        </div>
      )}

      {error && (
        <div className="xiaoluo-pano-status is-error" role="alert">
          <Icon icon="mdi:image-broken-variant" width="22" height="22" />
          <span>{error}</span>
          <button type="button" className="xiaoluo-pano-retry" onClick={retry}>重试</button>
        </div>
      )}

      {immersive && !error && (
        <>
          <div className="xiaoluo-pano-controls" aria-label="全景查看控制">
            <button
              type="button"
              className={walking ? 'is-active' : ''}
              onClick={toggleWalking}
              data-tooltip={walking ? '关闭 WASD 漫游' : '开启 WASD 漫游'}
              aria-label={walking ? '关闭漫游' : '开启漫游'}
              aria-pressed={walking}
            >
              <Icon icon="mdi:walk" width="17" height="17" />
              <span>漫游</span>
            </button>
            <button
              type="button"
              className={showCorrections ? 'is-active' : ''}
              onClick={() => setShowCorrections((visible) => !visible)}
              data-tooltip="视觉矫正"
              aria-label={showCorrections ? '关闭视觉矫正' : '打开视觉矫正'}
              aria-pressed={showCorrections}
            >
              <Icon icon="mdi:tune-variant" width="17" height="17" />
              <span>矫正</span>
            </button>
            <span className="xiaoluo-pano-control-divider" />
            <button
              type="button"
              className="icon-only"
              onClick={() => updateHfov(Math.min(140, view.hfov + 5))}
              data-tooltip="缩小"
              aria-label="缩小"
            >
              <Icon icon="mdi:minus" width="17" height="17" />
            </button>
            <span className="xiaoluo-pano-zoom">{Math.round(95 / view.hfov * 100)}%</span>
            <button
              type="button"
              className="icon-only"
              onClick={() => updateHfov(Math.max(40, view.hfov - 5))}
              data-tooltip="放大"
              aria-label="放大"
            >
              <Icon icon="mdi:plus" width="17" height="17" />
            </button>
            <span className="xiaoluo-pano-control-divider" />
            <button
              type="button"
              className="icon-only"
              onClick={resetCorrections}
              data-tooltip="重置视角"
              aria-label="重置视角"
            >
              <Icon icon="mdi:restore" width="17" height="17" />
            </button>
          </div>

          {showCorrections && (
            <div className="xiaoluo-pano-corrections" aria-label="视觉矫正参数">
              <div className="xiaoluo-pano-corrections-header">
                <span>视觉矫正</span>
                <button
                  type="button"
                  onClick={resetCorrections}
                  data-tooltip="重置参数"
                  aria-label="重置参数"
                >
                  <Icon icon="mdi:restore" width="16" height="16" />
                </button>
              </div>
              <label className="xiaoluo-pano-toggle-row">
                <span>锁定水平线</span>
                <input type="checkbox" checked={shiftMode} onChange={toggleShiftMode} />
              </label>
              <label>
                <span>镜头焦距 <output>{Math.round(view.hfov)}°</output></span>
                <input
                  type="range"
                  min="40"
                  max="140"
                  value={Math.round(view.hfov)}
                  onChange={(event) => updateHfov(Number(event.target.value))}
                />
              </label>
              <label>
                <span>水平偏移 <output>{horizontalOffset}px</output></span>
                <input
                  type="range"
                  min="-80"
                  max="80"
                  value={horizontalOffset}
                  onChange={(event) => setHorizontalOffset(Number(event.target.value))}
                />
              </label>
              <label>
                <span>垂直偏移 <output>{verticalOffset}px</output></span>
                <input
                  type="range"
                  min="-40"
                  max="40"
                  value={verticalOffset}
                  onChange={(event) => setVerticalOffset(Number(event.target.value))}
                />
              </label>
              <label>
                <span>透视校正 <output>{perspective}°</output></span>
                <input
                  type="range"
                  min="-12"
                  max="12"
                  step="0.5"
                  value={perspective}
                  onChange={(event) => setPerspective(Number(event.target.value))}
                />
              </label>
            </div>
          )}
        </>
      )}
    </div>
  );
});

export default memo(XiaoLuoPanoramaViewer);
