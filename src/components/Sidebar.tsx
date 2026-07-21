import { useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { createPortal } from 'react-dom';
import type { JSX } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, computeImageNodeDimensions } from '../store/useAppStore';
import { countUnreadDramaAssets } from '../store/store.dramaAssets';
import ModalOverlay from './shared/ModalOverlay';
import type { NodeType } from '../types';
import { NODE_TYPE_CONFIG } from '../types';
import { uploadSourceFileToProject } from '../services/fileService';
import { getCanvasPointerPosition } from '../services/canvasPointerService';
import { classifyFile } from '../hooks/useNodeCreation';
import { checkForUpdate, downloadAndInstallUpdate } from '../services/updateService';
import AnimatedButton from './shared/AnimatedButton';
import PopupCloseButton from './shared/PopupCloseButton';
import ProjectLibraryModal from './ProjectLibraryModal';

/**
 * Sidebar 侧边栏面板 — 左侧节点类型列表、上传入口、项目切换、拖拽添加节点
 */

/* ============================================
   Node picker menu items
   ============================================ */
const generationItems: {
  type: NodeType;
  label: string;
  sub: string;
  icon: JSX.Element;
}[] = [
  {
    type: 'ai-text',
    label: '生成文本',
    sub: 'AI 文本生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-text'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-image',
    label: '生成图像',
    sub: 'AI 图像生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-image'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-video',
    label: '生成视频',
    sub: 'AI 视频生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-video'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-audio',
    label: '生成音频',
    sub: 'AI 音频生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-audio'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-panorama',
    label: '生成360全景',
    sub: 'AI 全景图生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-panorama'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-animation',
    label: '生成动画',
    sub: '2D 角色逐帧动画',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-animation'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-director',
    label: '3D 导演台',
    sub: '运镜预演 · 截图供生视频',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-director'].icon} width="18" height="18" />,
  },
];

const resourceItems = [
  {
    key: 'upload',
    label: '上传文件',
    sub: '图片 / 视频 / 音频',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
    ),
  },
];

const HELP_CATEGORIES = [
  {
    id: 'getting-started',
    label: '快速开始',
    icon: 'mdi:rocket-launch-outline',
    summary: '从创建节点到获得第一份结果',
    items: [
      {
        title: '创建内容节点',
        description: '点击左侧加号选择文本、图像、视频、音频、全景或动画节点。也可以直接按数字键 1-6 快速创建对应的生成节点。',
      },
      {
        title: '补充输入与模型',
        description: '选中节点后填写提示词、选择模型，并按需要添加参考素材。模型不可用时，先到“设置 > API Key”完成对应服务配置。',
      },
      {
        title: '生成并继续编排',
        description: '在节点中发起生成。结果会保留在当前项目中，可继续连接到下游节点，也可在左侧“输出历史”中回看。',
      },
    ],
  },
  {
    id: 'canvas',
    label: '画布导航',
    icon: 'mdi:cursor-move',
    summary: '选择、平移、缩放与快速定位',
    items: [
      {
        title: '选择与多选',
        description: '点击节点进行选择；按住 Shift 点击可追加选择。框选手势会跟随“设置 > 常规”中的画布交互模式。',
        shortcut: 'Shift + 点击',
      },
      {
        title: '平移与缩放',
        description: 'Figma 模式使用右键或中键拖动画布、滚轮缩放；经典模式使用左键拖动画布、Ctrl + 滚轮缩放。触控板可直接使用双指手势。',
      },
      {
        title: '找回画布内容',
        description: '按 F 将全部内容适配到当前视野；按 M 显示或隐藏小地图。画布右下角的缩放控件可精确调整比例。',
        shortcut: 'F / M',
      },
    ],
  },
  {
    id: 'nodes',
    label: '节点与连线',
    icon: 'mdi:vector-polyline',
    summary: '组织节点、建立数据流与批量编辑',
    items: [
      {
        title: '移动与编辑节点',
        description: '拖动节点标题区域调整位置。单独选中一个节点后按 Space，可直接打开该节点的提示词对话框，集中调整提示词、参数和参考内容。',
        shortcut: '选中节点 + Space',
      },
      {
        title: '连接上下游',
        description: '从节点的输出连接点拖向另一个节点的输入连接点。把连线释放到画布空白处时，可从菜单中创建后续节点。',
      },
      {
        title: '批量整理',
        description: '多选节点后可使用浮动工具栏对齐、分布或分组。Ctrl + G 用于分组或取消分组，误操作可用 Ctrl + Z 撤销。',
        shortcut: 'Ctrl/⌘ + G',
      },
    ],
  },
  {
    id: 'shortcuts',
    label: '快捷操作',
    icon: 'mdi:keyboard-outline',
    summary: '少点几次鼠标，更快完成高频编辑',
    items: [
      {
        title: '快速打开提示词',
        description: '先单独选中一个普通内容节点，再按 Space 打开提示词对话框。正在输入文字、多选节点、分组节点或 Markdown 节点时不会触发。',
        shortcut: '选中节点 + Space',
      },
      {
        title: '锁定节点缩放比例',
        description: '拖动节点右下角的尺寸控制点时按住 Shift，宽高会按当前比例一起变化；拖拽过程中也可以随时按下或松开 Shift 切换。',
        shortcut: '拖拽缩放 + Shift',
      },
      {
        title: '在鼠标位置创建节点',
        description: '按 1-6 创建文本、图像、视频、音频、全景和动画生成节点；按 Alt + 1-5 创建文本、图像、视频、音频和 Markdown 源节点。',
        shortcut: '1-6 / Alt + 1-5',
      },
      {
        title: '快速创建文本节点',
        description: '在画布空白区域双击，可直接创建一个文本生成节点。右键画布还能打开完整的节点创建菜单。',
        shortcut: '双击画布空白处',
      },
      {
        title: '复制、粘贴与删除',
        description: 'Ctrl/⌘ + C 和 Ctrl/⌘ + V 用于复制、粘贴选中节点；未复制节点时，直接粘贴外部图片或文件会将内容导入画布。Delete 或 Backspace 删除当前选择。',
        shortcut: 'Ctrl/⌘ + C / V',
      },
      {
        title: '保存、撤销与重做',
        description: 'Ctrl/⌘ + S 保存当前项目；Ctrl/⌘ + Z 撤销；Ctrl/⌘ + Y 或 Ctrl/⌘ + Shift + Z 重做。快捷键在输入框内会优先保留文字编辑行为。',
        shortcut: 'Ctrl/⌘ + S / Z / Y',
      },
      {
        title: '定位与资源搜索',
        description: 'F 适配全部画布内容，M 切换小地图，Esc 关闭当前弹窗或菜单。Alt + Space 或 Ctrl + Shift + Space 可打开资源搜索窗口。',
        shortcut: 'F / M / Esc',
      },
    ],
  },
  {
    id: 'generation',
    label: 'AI 生成',
    icon: 'mdi:creation-outline',
    summary: '配置模型、引用素材与处理生成结果',
    items: [
      {
        title: '配置服务',
        description: '在“设置 > API Key”中添加模型服务和密钥。ComfyUI 用户还需在对应设置页配置服务地址或安装目录。',
      },
      {
        title: '选择正确的输入',
        description: '不同媒体节点会显示各自支持的参数。参考图、首尾帧或音频素材可通过节点连接或节点内的素材入口补充。',
      },
      {
        title: '留意付费操作',
        description: '通过画布助手生成图片、视频或音频时，本轮需要显式 @ 对应模型；实际调用前会再次展示模型并请求确认。',
      },
    ],
  },
  {
    id: 'projects',
    label: '项目与文件',
    icon: 'mdi:folder-outline',
    summary: '切换项目、导入素材与管理产出',
    items: [
      {
        title: '管理项目',
        description: '点击左上角项目入口可新建、切换或删除项目。每个项目拥有独立的画布、对话、任务、资产和记忆。',
      },
      {
        title: '导入本地素材',
        description: '从左侧加号选择“上传文件”，或将支持的文件拖入画布。素材会按类型创建为可继续连接和编辑的节点。',
      },
      {
        title: '查找历史内容',
        description: '“资产”用于浏览项目素材，“输出历史”用于回看生成结果。文件保存位置和外部程序路径可在设置中管理。',
      },
    ],
  },
  {
    id: 'assistant',
    label: '画布助手',
    icon: 'mdi:message-processing-outline',
    summary: '用自然语言查询和操作当前画布',
    items: [
      {
        title: '引用明确对象',
        description: '打开左侧画布助手后，可在输入中 @ 节点、模型、声音或资产。明确引用能减少歧义，并确保媒体生成使用你本轮选择的模型。',
      },
      {
        title: '理解协作模式',
        description: 'B 模式会在写入画布前请求确认；C 模式可自动完成画布写入。文件写入、永久删除、媒体生成和项目记忆写入始终需要确认。',
      },
      {
        title: '控制执行任务',
        description: '工具调用和执行步骤会显示在任务时间线中，可按状态暂停、继续或取消。切换项目不会把后台结果写入其他项目。',
      },
    ],
  },
] as const;

type HelpCategoryId = (typeof HELP_CATEGORIES)[number]['id'];

interface HelpDemoConfig {
  caption: string;
  steps: readonly {
    icon: string;
    label: string;
    tone: string;
  }[];
}

const HELP_DEMOS = {
  'getting-started': {
    caption: '创建节点，补充模型与输入，然后获得第一份生成结果。',
    steps: [
      { icon: 'lucide:plus', label: '创建节点', tone: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-400' },
      { icon: 'lucide:settings-2', label: '选择模型', tone: 'border-blue-400/25 bg-blue-500/10 text-blue-400' },
      { icon: 'lucide:sparkles', label: '生成结果', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
  canvas: {
    caption: '先选中内容，再平移或缩放画布，最后快速适配全部节点。',
    steps: [
      { icon: 'lucide:mouse-pointer-2', label: '选择内容', tone: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-400' },
      { icon: 'lucide:move', label: '平移缩放', tone: 'border-cyan-400/25 bg-cyan-500/10 text-cyan-400' },
      { icon: 'lucide:scan', label: '适配视野', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
  nodes: {
    caption: '选中节点后按 Space，可直接进入提示词与参数编辑。',
    steps: [
      { icon: 'lucide:box-select', label: '选中节点', tone: 'border-blue-400/25 bg-blue-500/10 text-blue-400' },
      { icon: 'lucide:keyboard', label: '按 Space', tone: 'border-amber-400/25 bg-amber-500/10 text-amber-400' },
      { icon: 'lucide:panel-top-open', label: '打开编辑', tone: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-400' },
    ],
  },
  shortcuts: {
    caption: '拖动节点尺寸时按住 Shift，可随时切换为等比缩放。',
    steps: [
      { icon: 'lucide:move-diagonal-2', label: '拖动尺寸', tone: 'border-blue-400/25 bg-blue-500/10 text-blue-400' },
      { icon: 'lucide:arrow-up', label: '按住 Shift', tone: 'border-amber-400/25 bg-amber-500/10 text-amber-400' },
      { icon: 'lucide:proportions', label: '锁定比例', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
  generation: {
    caption: '在画布助手中明确引用模型，确认调用后再生成媒体内容。',
    steps: [
      { icon: 'lucide:at-sign', label: '引用模型', tone: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-400' },
      { icon: 'lucide:badge-check', label: '确认调用', tone: 'border-amber-400/25 bg-amber-500/10 text-amber-400' },
      { icon: 'lucide:image', label: '生成内容', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
  projects: {
    caption: '项目、导入素材与资产历史保持在同一个独立工作空间中。',
    steps: [
      { icon: 'lucide:folder-plus', label: '新建项目', tone: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-400' },
      { icon: 'lucide:file-up', label: '导入素材', tone: 'border-blue-400/25 bg-blue-500/10 text-blue-400' },
      { icon: 'lucide:archive', label: '管理资产', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
  assistant: {
    caption: '描述任务并确认执行计划，助手会把每一步结果写回正确项目。',
    steps: [
      { icon: 'lucide:message-square', label: '描述任务', tone: 'border-blue-400/25 bg-blue-500/10 text-blue-400' },
      { icon: 'lucide:list-checks', label: '确认计划', tone: 'border-amber-400/25 bg-amber-500/10 text-amber-400' },
      { icon: 'lucide:workflow', label: '执行画布', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
} satisfies Record<HelpCategoryId, HelpDemoConfig>;

function HelpDemo({ categoryId }: { categoryId: HelpCategoryId }) {
  const rootRef = useRef<HTMLElement>(null);
  const [playbackKey, setPlaybackKey] = useState(0);
  const demo = HELP_DEMOS[categoryId];

  useEffect(() => {
    const root = rootRef.current;
    if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let cancelled = false;
    let context: { revert: () => void } | undefined;

    // GSAP is only needed while the help demo is mounted.
    void import('gsap').then(({ gsap }) => {
      if (cancelled || !rootRef.current) return;

      context = gsap.context(() => {
        const steps = gsap.utils.toArray<HTMLElement>('[data-help-demo-step]');
        const connectors = gsap.utils.toArray<HTMLElement>('[data-help-demo-connector]');
        const caption = root.querySelector<HTMLElement>('[data-help-demo-caption]');

        gsap.set(steps, { opacity: 0.35, transform: 'translateY(4px) scale(0.96)' });
        gsap.set(connectors, {
          opacity: 0.35,
          transform: 'scaleX(0)',
          transformOrigin: 'left center',
        });
        if (caption) gsap.set(caption, { opacity: 0, transform: 'translateY(4px)' });

        const timeline = gsap.timeline();
        steps.forEach((step, index) => {
          timeline.to(step, {
            opacity: 1,
            transform: 'translateY(0) scale(1)',
            duration: 0.28,
            ease: 'power3.out',
          }, index === 0 ? 0 : '>+0.06');

          const connector = connectors[index];
          if (connector) {
            timeline.to(connector, {
              opacity: 1,
              transform: 'scaleX(1)',
              duration: 0.32,
              ease: 'power2.inOut',
            }, '>-0.04');
          }
        });

        if (caption) {
          timeline.to(caption, {
            opacity: 1,
            transform: 'translateY(0)',
            duration: 0.24,
            ease: 'power3.out',
          }, '>-0.05');
        }
      }, root);
    });

    return () => {
      cancelled = true;
      context?.revert();
    };
  }, [categoryId, playbackKey]);

  return (
    <section
      ref={rootRef}
      aria-label={`${demo.caption} 操作演示`}
      className="relative mb-5 overflow-hidden rounded-lg border border-canvas-border bg-canvas-bg/60 px-3 py-3"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(var(--separator-color)_1px,transparent_1px)] [background-size:12px_12px]"
        aria-hidden="true"
      />
      <div className="relative mb-3 flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-canvas-text-secondary">操作演示</span>
        <button
          type="button"
          aria-label="重新播放操作演示"
          data-tooltip="重新播放"
          onClick={() => setPlaybackKey((key) => key + 1)}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
        >
          <Icon icon="lucide:rotate-ccw" width="14" height="14" aria-hidden="true" />
        </button>
      </div>

      <div className="relative flex min-h-14 items-center">
        {demo.steps.map((step, index) => (
          <div key={step.label} className="contents">
            <div
              data-help-demo-step
              className={`flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1.5 rounded-lg border px-1.5 ${step.tone}`}
            >
              <Icon icon={step.icon} width="17" height="17" aria-hidden="true" />
              <span className="max-w-full truncate text-[10px] font-medium text-canvas-text-secondary">{step.label}</span>
            </div>
            {index < demo.steps.length - 1 ? (
              <div
                data-help-demo-connector
                className="mx-2 h-px min-w-3 flex-[0.35] bg-[var(--separator-color)]"
                aria-hidden="true"
              />
            ) : null}
          </div>
        ))}
      </div>

      <p
        data-help-demo-caption
        className="relative mt-3 text-pretty text-[11px] leading-5 text-canvas-text-secondary"
      >
        {demo.caption}
      </p>
    </section>
  );
}

/* ============================================
   Node Picker popup
   ============================================ */
function NodePicker({
  onEnter,
  onLeave,
}: {
  onEnter: () => void;
  onLeave: () => void;
}) {
  const { nodePickerOpen, closeNodePicker, addNode, currentProjectId, showToast } = useAppStore(
    useShallow((s) => ({
      nodePickerOpen: s.nodePickerOpen,
      closeNodePicker: s.closeNodePicker,
      addNode: s.addNode,
      currentProjectId: s.currentProjectId,
      showToast: s.showToast,
    })),
  );
  const pickerRef = useRef<HTMLDivElement>(null);

  const handleAddNode = (type: NodeType) => {
    const isImage = type === 'ai-image';
    const isPanorama = type === 'ai-panorama';
    const isAnimation = type === 'ai-animation';
    const isDirector = type === 'ai-director';
    const nodeData: Record<string, unknown> = {
      label: NODE_TYPE_CONFIG[type]?.label || generationItems.find((m) => m.type === type)?.label || '节点',
      type,
      prompt: '',
      status: 'idle' as const,
      nodeWidth: isAnimation || isDirector ? 320 : isPanorama ? 300 : 280,
      nodeHeight: isDirector ? 240 : isImage ? 158 : isAnimation ? 358 : isPanorama ? 200 : 160,
    };
    if (isImage) {
      nodeData.aspectRatio = '16:9';
      nodeData.imageSize = '2K';
    }
    if (isPanorama) {
      nodeData.previewMode = 'image';
    }
    if (isAnimation) {
      nodeData.prompt = '2D俯视角游戏角色，保持角色造型、朝向、比例和光照一致';
      nodeData.animationAction = 'idle';
      nodeData.animationFrames = 8;
      nodeData.animationPreviewMode = 'playing';
      nodeData.aspectRatio = '1:1';
      nodeData.imageSize = '2K';
    }
    if (isDirector) {
      nodeData.role = 'source';
      nodeData.directorStatus = 'idle';
      nodeData.directorCaptureUrls = [];
    }
    // Auto-fill default model from localStorage preference
    // 全景图节点回退到生图节点偏好
    try {
      const raw = localStorage.getItem('canvas-model-prefs');
      if (raw) {
        const prefs: Record<string, string> = JSON.parse(raw);
        const modelValue = prefs[type]
          || (type === 'ai-panorama' || type === 'ai-animation' ? prefs['ai-image'] : undefined);
        if (modelValue) {
          const slashIdx = modelValue.indexOf('/');
          if (slashIdx !== -1) {
            const provider = modelValue.slice(0, slashIdx);
            if (provider) {
              nodeData.model = modelValue;
              nodeData.provider = provider;
            }
          }
        }
      }
    } catch { /* ignore */ }
    const pos = getCanvasPointerPosition();
    addNode({
      id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      position: pos,
      data: nodeData,
    } as never);
    closeNodePicker();
  };

  const handleUploadFile = async () => {
    closeNodePicker();
    try {
      const result = await uploadSourceFileToProject('*/*', currentProjectId);
      if (!result) return;

      const ext = result.fileName.split('.').pop()?.toLowerCase() || '';
      const category = classifyFile(ext);

      if (!category) {
        showToast('不支持的文件类型', 'error');
        return;
      }

      const pos = getCanvasPointerPosition();
      const typeMap: Record<string, { type: NodeType; label: string; field: string }> = {
        image: { type: 'ai-image', label: result.fileName, field: 'imageUrl' },
        video: { type: 'ai-video', label: result.fileName, field: 'videoUrl' },
        audio: { type: 'ai-audio', label: result.fileName, field: 'audioUrl' },
        text: { type: 'ai-text', label: result.fileName, field: 'output' },
      };
      const info = typeMap[category];

      const nodeData: Record<string, unknown> = {
        label: info.label,
        type: info.type,
        role: 'source',
        status: 'success',
        fileName: result.fileName,
        nodeWidth: info.type === 'ai-audio' ? 260 : 280,
        nodeHeight: 160,
        [info.field]: result.dataUrl,
        ...(result.filePath ? { filePath: result.filePath } : {}),
        ...(info.field === 'output' ? { prompt: '' } : {}),
      };

      if (category === 'image' && result.dataUrl) {
        try {
          const dims = await computeImageNodeDimensions(result.dataUrl);
          Object.assign(nodeData, dims);
        } catch { /* ignore */ }
      }

      addNode({
        id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: info.type,
        position: pos,
        data: nodeData,
      } as never);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '上传失败';
      showToast(msg, 'error');
    }
  };

  return (
    <AnimatePresence>
      {nodePickerOpen && (
        <motion.div
          ref={pickerRef}
          className="node-picker"
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          initial={{ opacity: 0, scale: 0.95, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
      <div className="menu-section">
        <span className="menu-title">画布自由生成</span>
        <div className="menu-rule" />
      </div>
      {generationItems.map(({ type, label, sub, icon }) => (
        <AnimatedButton
          key={type}
          scale={1.02}
          className="menu-row has-desc"
          onClick={() => {
            handleAddNode(type);
          }}
        >
          <div className="menu-ico">{icon}</div>
          <div className="menu-txt-wrap">
            <span className="menu-lbl">{label}</span>
            <span className="menu-sub">{sub}</span>
          </div>
        </AnimatedButton>
      ))}
      <div className="menu-section">
        <span className="menu-title">添加资源</span>
        <div className="menu-rule" />
      </div>
      {resourceItems.map(({ key, label, sub, icon }) => (
        <AnimatedButton key={key} scale={1.02} className="menu-row has-desc"
          onClick={async () => {
            if (key === 'upload') return handleUploadFile();
          }}
        >
          <div className="menu-ico">{icon}</div>
          <div className="menu-txt-wrap">
            <span className="menu-lbl">{label}</span>
            <span className="menu-sub">{sub}</span>
          </div>
        </AnimatedButton>
      ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ============================================
   Avatar / Settings dropdown menu
   ============================================ */
function AvatarMenu() {
  const { avatarMenuOpen, closeAvatarMenu, setSettingsOpen } = useAppStore(
    useShallow((s) => ({
      avatarMenuOpen: s.avatarMenuOpen,
      closeAvatarMenu: s.closeAvatarMenu,
      setSettingsOpen: s.setSettingsOpen,
    })),
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [activeHelpCategory, setActiveHelpCategory] = useState<HelpCategoryId>('getting-started');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'no-update' | 'available' | 'updating' | 'error'>('idle');
  const [updateMsg, setUpdateMsg] = useState('');
  const [updateVersion, setUpdateVersion] = useState('');

  const handleCheckUpdate = async () => {
    setUpdateStatus('checking');
    setUpdateMsg('');
    try {
      const result = await checkForUpdate();
      if (result.available) {
        setUpdateStatus('available');
        setUpdateVersion(result.version);
        setUpdateMsg(`发现新版本 v${result.version}`);
      } else {
        setUpdateStatus('no-update');
        setUpdateMsg('已是最新版本');
      }
    } catch {
      setUpdateStatus('error');
      setUpdateMsg('检查失败，请稍后重试');
    }
  };

  const handleDownloadUpdate = async () => {
    setUpdateStatus('updating');
    setUpdateMsg('正在下载更新...');
    const ok = await downloadAndInstallUpdate();
    if (!ok) {
      setUpdateStatus('error');
      setUpdateMsg('下载失败，请稍后重试');
    }
  };

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  useEffect(() => {
    if (!avatarMenuOpen) return;
    const handler = (e: MouseEvent) => {
      // Ignore clicks on the gear button itself
      const gearBtn = document.getElementById('btn-user-gear');
      if (gearBtn && gearBtn.contains(e.target as Node)) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeAvatarMenu();
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [avatarMenuOpen, closeAvatarMenu]);

  const selectedHelpCategory = HELP_CATEGORIES.find(({ id }) => id === activeHelpCategory)
    ?? HELP_CATEGORIES[0];

  return (
    <>
      <AnimatePresence>
      {avatarMenuOpen && (
        <motion.div
          ref={menuRef}
          className="avatar-menu"
          initial={{ opacity: 0, scale: 0.95, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
          <AnimatedButton
            type="button"
            className="avatar-menu-item"
            scale={1.02}
            onClick={() => {
              setSettingsOpen(true);
              closeAvatarMenu();
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            设置
          </AnimatedButton>
          <div className="avatar-menu-sep" />
          <AnimatedButton
            type="button"
            className="avatar-menu-item"
            scale={1.02}
            onClick={() => {
              setHelpOpen(true);
              closeAvatarMenu();
            }}
          >
            <Icon icon="mdi:help-circle-outline" width="16" height="16" aria-hidden="true" />
            帮助
          </AnimatedButton>
          <AnimatedButton
            type="button"
            className="avatar-menu-item"
            onClick={() => {
              setAboutOpen(true);
              closeAvatarMenu();
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            关于
          </AnimatedButton>
        </motion.div>
      )}
    </AnimatePresence>

      {/* Help dialog — portal to body to escape aside containing block */}
      {createPortal(
        <ModalOverlay
          isOpen={helpOpen}
          onClose={() => setHelpOpen(false)}
          ariaLabel="AI Canvas 使用帮助"
          className="h-[min(620px,calc(100vh-24px))] w-[min(760px,calc(100vw-24px))]"
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex shrink-0 items-center justify-between border-b border-canvas-border px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-400">
                  <Icon icon="mdi:book-open-page-variant-outline" width="20" height="20" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-canvas-text">使用帮助</h2>
                  <p className="mt-0.5 truncate text-xs text-canvas-text-secondary">按场景查找常用操作和注意事项</p>
                </div>
              </div>
              <PopupCloseButton ariaLabel="关闭帮助" onClick={() => setHelpOpen(false)} />
            </header>

            <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
              <nav
                aria-label="帮助分类"
                className="flex shrink-0 gap-1 overflow-x-auto border-b border-canvas-border p-2 sm:w-48 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r sm:p-3"
              >
                {HELP_CATEGORIES.map((category) => {
                  const isActive = category.id === activeHelpCategory;
                  return (
                    <button
                      key={category.id}
                      type="button"
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => setActiveHelpCategory(category.id)}
                      className={`group flex min-w-max items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors sm:min-w-0 ${
                        isActive
                          ? 'bg-indigo-500/15 font-medium text-indigo-300'
                          : 'text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text'
                      }`}
                    >
                      <Icon
                        icon={category.icon}
                        width="16"
                        height="16"
                        className={isActive ? 'text-indigo-400' : 'text-canvas-text-muted group-hover:text-canvas-text-secondary'}
                        aria-hidden="true"
                      />
                      <span>{category.label}</span>
                    </button>
                  );
                })}
              </nav>

              <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
                <div className="mx-auto max-w-xl">
                  <div className="mb-5">
                    <p className="text-[11px] font-medium text-indigo-400">{selectedHelpCategory.label}</p>
                    <h3 className="mt-1 text-lg font-semibold text-canvas-text">{selectedHelpCategory.summary}</h3>
                  </div>

                  <HelpDemo categoryId={activeHelpCategory} />

                  <ol className="space-y-1">
                    {selectedHelpCategory.items.map((item, index) => (
                      <li key={item.title} className="flex gap-4 border-b border-canvas-border/70 py-4 first:pt-0 last:border-b-0">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-canvas-hover text-[11px] font-semibold text-canvas-text-secondary">
                          {index + 1}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="text-sm font-medium text-canvas-text">{item.title}</h4>
                            {'shortcut' in item && item.shortcut ? (
                              <kbd className="rounded-md border border-canvas-border bg-canvas-hover px-1.5 py-0.5 font-sans text-[10px] font-medium text-canvas-text-secondary">
                                {item.shortcut}
                              </kbd>
                            ) : null}
                          </div>
                          <p className="mt-1.5 text-xs leading-5 text-canvas-text-secondary">{item.description}</p>
                        </div>
                      </li>
                    ))}
                  </ol>

                  <div className="mt-5 flex items-start gap-2 border-t border-canvas-border pt-4 text-xs leading-5 text-canvas-text-muted">
                    <Icon icon="mdi:keyboard-outline" width="16" height="16" className="mt-0.5 shrink-0" aria-hidden="true" />
                    <p>完整快捷键可在“设置 &gt; 快捷键”中查看；按 Esc 可随时关闭当前弹窗或菜单。</p>
                  </div>
                </div>
              </main>
            </div>
          </div>
        </ModalOverlay>,
        document.body,
      )}

      {/* About dialog — portal to body to escape aside containing block */}
      {createPortal(
        <ModalOverlay
          isOpen={aboutOpen}
          onClose={() => setAboutOpen(false)}
          ariaLabel="关于 AI Canvas"
          className="w-[420px] max-h-[85vh] overflow-y-auto"
        >
        <div className="p-4 space-y-4">
          {/* Header */}
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500/20">
              <img src="/icons.svg" alt="" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-canvas-text">AI Canvas</h2>
              <p className="text-xs text-canvas-text-secondary">v{appVersion} · 开发预览版</p>
              <button
                onClick={updateStatus === 'available' ? handleDownloadUpdate : handleCheckUpdate}
                disabled={updateStatus === 'checking' || updateStatus === 'updating'}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 disabled:text-canvas-text-muted transition-colors"
              >
                {updateStatus === 'checking' ? (
                  <>
                    <Icon icon="svg-spinners:90-ring" width="12" height="12" />
                    检查中...
                  </>
                ) : updateStatus === 'updating' ? (
                  <>
                    <Icon icon="svg-spinners:90-ring" width="12" height="12" />
                    下载中...
                  </>
                ) : updateStatus === 'no-update' && updateMsg ? (
                  updateMsg
                ) : updateStatus === 'available' ? (
                  `发现 v${updateVersion}，点击更新`
                ) : updateStatus === 'error' ? (
                  updateMsg
                ) : (
                  '检查更新'
                )}
              </button>
            </div>
          </div>

          {/* Description */}
          <p className="text-sm text-canvas-text-secondary leading-relaxed">
            AI Canvas 是一个智能多媒体创意画布，通过可视化节点编排的方式，
            调用多种 AI 模型来生成文本、图像、视频和音频内容。支持多厂商模型接入、
            ComfyUI 工作流、本地文件管理与实时协作。
          </p>

          {/* Feature list */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase text-canvas-text-muted">核心能力</h3>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'AI 文本生成', color: 'bg-indigo-500/20 text-indigo-400' },
                { label: 'AI 图像生成', color: 'bg-green-500/20 text-green-400' },
                { label: 'AI 视频生成', color: 'bg-blue-500/20 text-blue-400' },
                { label: 'AI 音频生成', color: 'bg-orange-500/20 text-orange-400' },
                { label: 'ComfyUI 工作流', color: 'bg-purple-500/20 text-purple-400' },
                { label: '节点分组管理', color: 'bg-cyan-500/20 text-cyan-400' },
                { label: '画布无限缩放', color: 'bg-pink-500/20 text-pink-400' },
                { label: '本地文件读写', color: 'bg-yellow-500/20 text-yellow-400' },
              ].map(({ label, color }) => (
                <span
                  key={label}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium ${color}`}
                >
                  {label}
                </span>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-canvas-border" />

          {/* Tech stack */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase text-canvas-text-muted">技术栈</h3>
            <div className="flex flex-wrap gap-1.5">
              {['Tauri 2', 'React 19', 'React Flow 12', 'TypeScript', 'Zustand 5', 'Tailwind CSS 3', 'Vite 8'].map((tech) => (
                <span key={tech} className="px-2.5 py-1 rounded-md bg-canvas-hover text-xs text-canvas-text-secondary">
                  {tech}
                </span>
              ))}
            </div>
          </div>

          {/* Community */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase text-canvas-text-muted">社区</h3>
            <div className="flex flex-col gap-2">
              <a
                href="https://github.com/Tenney95/AI-Canvas-tauri"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-canvas-hover hover:bg-canvas-border transition-colors text-xs text-canvas-text-secondary hover:text-canvas-text"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                GitHub
              </a>
              <button
                type="button"
                onClick={() => {
                  const qq = '873354155';
                  navigator.clipboard?.writeText(qq).catch(() => {});
                  useAppStore.getState().showToast('已复制 QQ 群号：873354155');
                }}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-canvas-hover hover:bg-canvas-border transition-colors text-xs text-canvas-text-secondary hover:text-canvas-text text-left cursor-pointer"
                data-tooltip="点击复制 QQ 群号"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a39.548 39.548 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a38.97 38.97 0 0 0-.802 2.264c-1.021 3.283-1.045 4.643-1.045 4.643 0 1.706 1.036 2.841 2.439 2.841.808 0 1.258-.387 1.85-.92.228-.206.463-.372.708-.498.449-.23 1.022-.405 1.719-.479 1.087-.116 3.274-.464 5.223-.464h.001c1.949 0 4.136.348 5.223.464.697.074 1.27.249 1.719.479.245.126.48.292.708.498.592.533 1.042.92 1.85.92 1.403 0 2.439-1.135 2.439-2.841 0 0-.025-1.361-1.046-4.643z"/></svg>
                QQ 群：873354155
              </button>
            </div>
          </div>

          {/* Footer */}
          <div className="pt-2 flex items-center justify-between border-t border-canvas-border">
            <span className="text-[11px] text-canvas-text-muted">© 2026 AI Canvas Team</span>
            <AnimatedButton
              type="button"
              className="px-3 py-1.5 text-xs font-medium text-canvas-text bg-canvas-hover hover:bg-canvas-border rounded-lg transition-colors"
              onClick={() => setAboutOpen(false)}
            >
              知道了
            </AnimatedButton>
          </div>
        </div>
      </ModalOverlay>,
        document.body,
      )}
    </>
  );
}

/* ============================================
   Logo / Project switcher menu
   ============================================ */
function LogoMenu() {
  const [open, setOpen] = useState(false);

  const openProjectLibrary = () => {
    setOpen(true);
    window.setTimeout(async () => {
      const store = useAppStore.getState();
      const capturedProjectId = await store.captureCurrentProjectSnapshot();
      if (capturedProjectId && useAppStore.getState().currentProjectId === capturedProjectId) {
        await useAppStore.getState().saveCurrentProjectSilent();
      }
    }, 220);
  };

  return (
    <>
      <button
        type="button"
        className={`sidebar-btn-v3 sidebar-canvas-btn ${open ? 'active' : ''}`}
        data-tooltip="画布 / 项目"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openProjectLibrary}
      >
        <svg className="ico-normal" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M3 4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zm0 14a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM18 3a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zm-1 8a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1zm-6-1a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1zm-8 1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zm8-8a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zm-1 15a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1zm8-1a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1z" clipRule="evenodd" />
        </svg>
        <svg className="ico-hover" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <rect x="3" y="4" width="13" height="16" rx="2" />
          <path d="m19 8 3 4-3 4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M13 12h9" strokeLinecap="round" />
        </svg>
      </button>

      {createPortal(
        <ProjectLibraryModal isOpen={open} onClose={() => setOpen(false)} />,
        document.body,
      )}
    </>
  );
}

/* ============================================
   Main Sidebar
   ============================================ */
export default function Sidebar() {
  const {
    openNodePicker,
    closeNodePicker,
    toggleAvatarMenu,
    nodePickerOpen,
    setAssetsPanelOpen,
    setHistoryPanelOpen,
    unreadDramaAssetCount,
  } = useAppStore(
      useShallow((s) => ({
        openNodePicker: s.openNodePicker,
        closeNodePicker: s.closeNodePicker,
        toggleAvatarMenu: s.toggleAvatarMenu,
        nodePickerOpen: s.nodePickerOpen,
        setAssetsPanelOpen: s.setAssetsPanelOpen,
        setHistoryPanelOpen: s.setHistoryPanelOpen,
        unreadDramaAssetCount: countUnreadDramaAssets(s.dramaAssets),
      })),
    );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleAddEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openNodePicker();
  };
  const handleAddLeave = () => {
    closeTimer.current = setTimeout(closeNodePicker, 120);
  };
  const handlePickerEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  const handlePickerLeave = () => {
    closeNodePicker();
  };

  return (
    <aside data-tauri-drag-region className="sidebar-floating">
      {/* Add button — hover to open node picker */}
      <button
        id="btn-add-node"
        type="button"
        className={`sidebar-btn-v3 add-btn-v3 ${nodePickerOpen ? 'active' : ''}`}
        onMouseEnter={handleAddEnter}
        onMouseLeave={handleAddLeave}
        onClick={() => (nodePickerOpen ? closeNodePicker() : openNodePicker())}
        aria-label="添加节点"
      >
        {/* Normal: plus */}
        <svg className="ico-normal" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        {/* Hover/active: cross */}
        <svg className="ico-hover" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </button>

      {/* Logo / Canvas home */}
      <div className="sidebar-logo-wrap">
        <LogoMenu />
      </div>

      {/* Assets */}
      <button
        type="button"
        className="sidebar-btn-v3"
        data-tooltip={unreadDramaAssetCount > 0 ? `资产 · 新增短剧资产 (${unreadDramaAssetCount})` : '资产'}
        onClick={() => setAssetsPanelOpen(true)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"><path strokeDasharray="64" strokeDashoffset="64" d="M12 7h8c0.55 0 1 0.45 1 1v10c0 0.55 -0.45 1 -1 1h-16c-0.55 0 -1 -0.45 -1 -1v-11Z"><animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="64;0"/></path><path d="M12 7h-9v0c0 0 0.45 0 1 0h6z" opacity="0"><animate fill="freeze" attributeName="d" begin="0.6s" dur="0.2s" values="M12 7h-9v0c0 0 0.45 0 1 0h6z;M12 7h-9v-1c0 -0.55 0.45 -1 1 -1h6z"/><set fill="freeze" attributeName="opacity" begin="0.6s" to="1"/></path></g></svg>
        {unreadDramaAssetCount > 0 ? (
          <span className="sidebar-badge">
            {unreadDramaAssetCount > 99 ? '99+' : unreadDramaAssetCount}
          </span>
        ) : null}
      </button>

      {/* History */}
      <button type="button" className="sidebar-btn-v3" data-tooltip="输出历史" onClick={() => setHistoryPanelOpen(true)}>
        <svg width="20" height="20" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"><path d="M11.007 21H9.605c-3.585 0-5.377 0-6.491-1.135S2 16.903 2 13.25s0-5.48 1.114-6.615S6.02 5.5 9.605 5.5h3.803c3.585 0 5.378 0 6.492 1.135c.857.873 1.054 2.156 1.1 4.365"/><path d="m18.85 18.85l-1.35-.9V15.7M13 17.5a4.5 4.5 0 1 0 9 0a4.5 4.5 0 0 0-9 0m3-12l-.1-.31c-.494-1.54-.742-2.31-1.331-2.75C13.979 2 13.197 2 11.632 2h-.264c-1.565 0-2.348 0-2.937.44c-.59.44-.837 1.21-1.332 2.75L7 5.5"/></g></svg>
      </button>

      {/* AI Chat Assistant */}
      <button
        type="button"
        className="sidebar-btn-v3"
        data-tooltip="画布助手"
        onClick={async () => {
          const store = useAppStore.getState();
          if (store.chatPanelDetached) {
            // 已分离 → 收回内嵌
            const { emitCloseChatWindow } = await import('../services/chat/chatWindowService');
            try {
              await emitCloseChatWindow();
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke('close_chat_window');
            } catch { /* ignore */ }
            store.setChatPanelDetached(false);
          } else {
            store.toggleChat();
          }
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <rect x="8.4" y="9.25" width="2" height="5.5" rx="1" fill="currentColor" />
          <rect x="13.6" y="9.25" width="2" height="5.5" rx="1" fill="currentColor" />
        </svg>
      </button>

      {/* Task Center */}
      {/* <button type="button" className="sidebar-btn-v3 task-center-btn">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M9 6h11" strokeLinecap="round" />
          <path d="M9 12h11" strokeLinecap="round" />
          <path d="M9 18h11" strokeLinecap="round" />
          <path d="M4 6l1 1 2-2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 12l1 1 2-2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 18l1 1 2-2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="task-center-tooltip">
          <span>任务</span>
          <span className="task-center-tooltip-beta">beta</span>
        </span>
      </button> */}

      {/* Separator */}
      <div className="sidebar-sep-v3" />

      {/* Settings / Avatar */}
      <div className="avatar-wrap">
        <button
          id="btn-user-gear"
          type="button"
          className="user-gear-plain"
          onClick={toggleAvatarMenu}
          data-tooltip="设置"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
        </button>
        <AvatarMenu />
      </div>

      {/* Node Picker popup */}
      <NodePicker onEnter={handlePickerEnter} onLeave={handlePickerLeave} />
    </aside>
  );
}
