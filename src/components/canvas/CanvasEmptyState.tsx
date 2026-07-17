/**
 * CanvasEmptyState 画布空状态提示 — 画布无节点时显示引导界面，提供快速添加节点的入口按钮
 */
import { memo } from 'react';
import type { NodeType } from '../../types';
import { useAppStore, generateId } from '../../store/useAppStore';
import AnimatedButton from '../shared/AnimatedButton';

const EMPTY_STATE_NODE_TYPES = ['ai-text', 'ai-image', 'ai-video'] as NodeType[];

const EMPTY_STATE_LABELS: Partial<Record<NodeType, string>> = {
  'ai-text': '生成文本',
  'ai-image': '生成图像',
  'ai-video': '生成视频',
  'ai-audio': '生成音频',
};

function CanvasEmptyState() {
  const addNode = useAppStore((s) => s.addNode);

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
      <div className="flex flex-col items-center gap-4 opacity-50">
        <div className="w-16 h-16 rounded-2xl bg-canvas-card border border-canvas-border flex items-center justify-center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2">
            <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
            <circle cx="2" cy="2" r="1.5" fill="var(--brand)" />
          </svg>
        </div>
        <div className="text-center">
          <div className="text-lg font-medium text-canvas-text mb-1">AI画布</div>
          <div className="text-sm text-canvas-text-muted">右键自由生成节点，或从左侧面板选择节点类型</div>
        </div>
        <div className="flex gap-2 mt-2 pointer-events-auto">
          {EMPTY_STATE_NODE_TYPES.map((type) => (
            <AnimatedButton
              key={type}
              onClick={() => {
                const offset = Math.random() * 100;
                addNode({
                  id: `node-${generateId()}`,
                  type,
                  position: { x: 250 + offset * 3, y: 200 + offset * 2 },
                  data: {
                    label: EMPTY_STATE_LABELS[type] || '',
                    type,
                    prompt: '',
                    status: 'idle',
                  },
                });
              }}
              className="px-4 py-2 bg-canvas-card border border-canvas-border rounded-lg text-sm text-canvas-text-secondary hover:border-indigo-500/50 hover:text-canvas-text transition-colors"
            >
              {EMPTY_STATE_LABELS[type]}
            </AnimatedButton>
          ))}
        </div>
      </div>
    </div>
  );
}

export default memo(CanvasEmptyState);
