/**
 * FreeAnglePanel — 自由角度控制面板
 * 点击 ImageNodeToolbar 的"控制角度"按钮后弹出，通过拖拽/滑块控制 3D 正方体角度
 */
import { memo, useCallback, useRef, useState } from 'react';
import FullscreenOverlay from '../../../shared/FullscreenOverlay';
import '../../../../styles/freeangle.css';
import type { ModelGroup, ModelOption } from '../../../../types';
import ModelSelector from '../ModelSelector';

/* ── Props ── */
export interface FreeAnglePanelProps {
  isOpen: boolean;
  imageUrl?: string;
  onClose: () => void;
  onGenerate?: (params: { rotation: number; pitch: number; scale: number; model: string; provider: string }) => void;
}

/* ── 自由角度面板专属模型数据（ModelGroup 格式） ── */
const ANGLE_MODEL_GROUPS: ModelGroup[] = [
  {
    id: 'grsai',
    name: 'GRSAI',
    description: '高性能 AI 图像生成服务',
    iconType: 'badge',
    badgeText: 'GAI',
    models: [
      { value: 'gpt-image-2', provider: 'grsai', label: 'GPT image 2', description: 'OpenAI 图像生成模型', nodeTypes: ['ai-image'], iconType: 'badge', badgeText: 'GAI' } as ModelOption,
      { value: 'nano-banana-pro', provider: 'grsai', label: 'NanobananaPRO', description: '专业增强模型', nodeTypes: ['ai-image'], iconType: 'badge', badgeText: 'GAI' } as ModelOption,
      { value: 'nano-banana-2', provider: 'grsai', label: 'Nanobanana2', description: '第二代模型', nodeTypes: ['ai-image'], iconType: 'badge', badgeText: 'GAI' } as ModelOption,
    ],
  },
  {
    id: 'apimart',
    name: 'APIMart',
    description: '一个 API 搞定一切——节省 30-70%',
    iconType: 'badge',
    badgeText: 'AM',
    models: [
      { value: 'apimart/gemini-3.1-flash-image-preview', provider: 'apimart', label: 'Nano Banana 3.1', description: '最新 Nano Banana，最高画质', nodeTypes: ['ai-image'], iconType: 'badge', badgeText: 'AM' } as ModelOption,
      { value: 'apimart/gemini-3-pro-image-preview', provider: 'apimart', label: 'Nano Banana Pro', description: '专业级画质，光影渲染深度优化', nodeTypes: ['ai-image'], iconType: 'badge', badgeText: 'AM' } as ModelOption,
      { value: 'apimart/gpt-image-2', provider: 'apimart', label: 'GPT Image 2', description: 'OpenAI 图像生成，支持文生图与图生图', nodeTypes: ['ai-image'], iconType: 'badge', badgeText: 'AM' } as ModelOption,
      { value: 'apimart/imagen-4.0-apimart', provider: 'apimart', label: 'Imagen 4.0', description: 'Google 旗舰图像生成模型', nodeTypes: ['ai-image'], iconType: 'badge', badgeText: 'AM' } as ModelOption,
    ],
  },
  {
    id: 'runninghub',
    name: 'RunningHUB模型',
    description: '模型 API：文生图/图生图/图片编辑',
    iconType: 'badge',
    badgeText: 'RH',
    models: [
      { value: 'runninghub-model/rhart-image-n-pro', provider: 'runninghub', label: 'BananaPRO', description: '专业级画质，版本可在模式中切换', nodeTypes: ['ai-image'], iconType: 'badge', badgeText: 'RH' } as ModelOption,
      { value: 'runninghub-model/rhart-image-n-g31-flash', provider: 'runninghub', label: 'Banana2', description: '新一代图像模型，版本可在模式中切换', nodeTypes: ['ai-image'], iconType: 'badge', badgeText: 'RH' } as ModelOption,
      { value: 'runninghub-model/rhart-image-g-2', provider: 'runninghub', label: 'GPT image 2', description: 'OpenAI 图像生成模型，版本可在模式中切换', nodeTypes: ['ai-image'], iconType: 'badge', badgeText: 'RH' } as ModelOption,
    ],
  },
  {
    id: 'runninghubwf',
    name: 'RunningHUB工作流',
    description: '控制角度专用工作流',
    iconType: 'badge',
    badgeText: 'RH',
    models: [
      { value: 'runninghub/2053902968243671041', provider: 'runninghubwf', label: '控制摄像机', description: '控制角度专用 RunningHub 摄像机视角工作流', nodeTypes: ['ai-image'], iconType: 'badge', badgeText: 'RH' } as ModelOption,
    ],
  },
];

/* ── 工具函数 ── */
function normalizeAngle(deg: number): number {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

/* ════════════════════════════════════════════
   FreeAnglePanel
   ════════════════════════════════════════════ */
function FreeAnglePanel({ isOpen, imageUrl, onClose, onGenerate }: FreeAnglePanelProps) {
  // 角度状态
  const [rotation, setRotation] = useState(329.5); // 0-360，水平角度
  const [pitch, setPitch] = useState(0);            // -30 ~ 60，垂直角度
  const [cubeScale, setCubeScale] = useState(0.9);  // 0.1-2，距离

  // 模型选择
  const [selectedModel, setSelectedModel] = useState('runninghub/2053902968243671041');
  const [selectedProvider, setSelectedProvider] = useState('runninghubwf');

  // 滑块值映射：rotation slider 0-360 -> display value
  const sliderRotation = normalizeAngle(360 - rotation + 35);

  const handleRotationSlider = useCallback((val: number) => {
    setRotation(normalizeAngle(360 - val + 35));
  }, []);

  const handlePitchChange = useCallback((val: number) => {
    setPitch(val);
  }, []);

  const handleScaleChange = useCallback((val: number) => {
    setCubeScale(val);
  }, []);

  // 正方体拖拽
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, startRot: 0, startPitch: 0 });

  const handleCubePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragRef.current = { startX: e.clientX, startY: e.clientY, startRot: rotation, startPitch: pitch };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [rotation, pitch]);

  const handleCubePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    // 不做 normalizeAngle，让 rotation 自由累积 → CSS rotateY 天然支持任意角度值
    // 若归一化，当 startRot 接近 360 时，计算值跨越 360 边界会从 359 跳到 0，造成 360° 视觉反转
    const newRot = dragRef.current.startRot - dx * 0.5;
    const newPitch = Math.min(60, Math.max(-30, dragRef.current.startPitch - dy * 0.5));
    setRotation(newRot);
    setPitch(newPitch);
  }, [isDragging]);

  const handleCubePointerUp = useCallback((e: React.PointerEvent) => {
    setIsDragging(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  // 重置
  const handleReset = useCallback(() => {
    setRotation(329.5);
    setPitch(0);
    setCubeScale(0.9);
  }, []);

  // 模型选择回调
  const handleSelectModel = useCallback((model: ModelOption) => {
    setSelectedModel(model.value);
    setSelectedProvider(model.provider);
  }, []);

  // 生成
  const handleGenerate = useCallback(() => {
    onGenerate?.({ rotation: normalizeAngle(rotation), pitch, scale: cubeScale, model: selectedModel, provider: selectedProvider });
  }, [rotation, pitch, cubeScale, selectedModel, selectedProvider, onGenerate]);

  return (
    <FullscreenOverlay
      isOpen={isOpen}
      onClose={onClose}
      title="拖拽正方体改变角度"
      panelWidth="520px"
      bodyClassName="fa-body"
    >
      {/* 🔳 3D 正方体预览 */}
      <div className="fa-preview-area">
        <button className="fa-reset-btn" onClick={handleReset}>重置</button>
        <div className="fa-cube-container" style={{ transform: `scale(${1 + (cubeScale - 0.9) * 2.5})` }}>
          <div
            className="fa-cube"
            style={{ transform: `rotateX(${pitch}deg) rotateY(${-rotation}deg)` }}
            onPointerDown={handleCubePointerDown}
            onPointerMove={handleCubePointerMove}
            onPointerUp={handleCubePointerUp}
          >
            <div className="fa-cube-face face-front">
              {imageUrl ? (
                <img src={imageUrl} className="fa-face-img" alt="preview" draggable={false} />
              ) : (
                <span>前</span>
              )}
            </div>
            <div className="fa-cube-face face-back"><span>后</span></div>
            <div className="fa-cube-face face-right"><span>右</span></div>
            <div className="fa-cube-face face-left"><span>左</span></div>
            <div className="fa-cube-face face-top"><span>上</span></div>
            <div className="fa-cube-face face-bottom"><span>下</span></div>
          </div>
        </div>
      </div>

      {/* 🎚️ 滑块控制 */}
      <div className="fa-controls px-2">
        <div className="fa-control-item">
          <div className="fa-control-label-row">
            <span className="fa-label">水平角度</span>
            <span className="fa-value">{normalizeAngle(rotation).toFixed(1)}°</span>
          </div>
          <input
            type="range"
            className="fa-slider"
            min={0}
            max={360}
            step={0.5}
            value={sliderRotation}
            onChange={(e) => handleRotationSlider(Number(e.target.value))}
          />
        </div>
        <div className="fa-control-item">
          <div className="fa-control-label-row">
            <span className="fa-label">垂直角度</span>
            <span className="fa-value">{pitch.toFixed(1)}°</span>
          </div>
          <input
            type="range"
            className="fa-slider"
            min={-30}
            max={60}
            step={0.5}
            value={pitch}
            onChange={(e) => handlePitchChange(Number(e.target.value))}
          />
        </div>
        <div className="fa-control-item">
          <div className="fa-control-label-row">
            <span className="fa-label">距离</span>
            <span className="fa-value">{cubeScale.toFixed(2)}</span>
          </div>
          <input
            type="range"
            className="fa-slider"
            min={0.1}
            max={2}
            step={0.05}
            value={cubeScale}
            onChange={(e) => handleScaleChange(Number(e.target.value))}
          />
        </div>
      </div>

      {/* 📦 Footer: 模型选择 + 操作按钮 */}
      <div className="fa-footer p-2">
        <ModelSelector
          nodeType="ai-image"
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          onSelect={handleSelectModel}
          groups={ANGLE_MODEL_GROUPS}
          defaultExpandedGroupIds={['runninghubwf']}
        />

        <div className="fa-footer-actions">
          <button
            type="button"
            className="fa-debug-btn"
            title="调试 API 参数"
            aria-label="调试 API 参数"
            onClick={() => { /* TODO: 调试 */ }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
          </button>
          <button
            className="fa-gen-btn"
            title="生成"
            aria-label="生成"
            onClick={handleGenerate}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </div>
      </div>
    </FullscreenOverlay>
  );
}

export default memo(FreeAnglePanel);
