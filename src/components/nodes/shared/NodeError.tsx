/**
 * NodeError — 节点报错提示
 *
 * 显示 20 秒后缓慢淡出，淡出结束清除节点的 error 状态（并把 error 状态复位为 idle）。
 */
import { Icon } from '@iconify/react';
import { useEffect, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';

const VISIBLE_MS = 20000; // 显示时长
const FADE_MS = 1100; // 淡出动画时长（与 CSS transition 对齐）

export default function NodeError({ nodeId, message }: { nodeId: string; message: string }) {
  const updateNodeDataTransient = useAppStore((s) => s.updateNodeDataTransient);
  const [fadingMessage, setFadingMessage] = useState<string | null>(null);
  const fading = fadingMessage === message;

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFadingMessage(message), VISIBLE_MS);
    const clearTimer = setTimeout(() => {
      const node = useAppStore.getState().nodes.find((n) => n.id === nodeId);
      const patch: Record<string, unknown> = { error: undefined };
      // 仅当仍处于 error 状态时复位为 idle，避免覆盖后续新状态
      if ((node?.data as { status?: string } | undefined)?.status === 'error') {
        patch.status = 'idle';
      }
      updateNodeDataTransient(nodeId, patch);
    }, VISIBLE_MS + FADE_MS);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(clearTimer);
    };
  }, [nodeId, message, updateNodeDataTransient]);

  return (
    <div
      role="alert"
      aria-atomic="true"
      className={`node-error nodrag nopan nowheel${fading ? ' node-error--fading' : ''}`}
    >
      <Icon className="node-error__icon" icon="lucide:triangle-alert" width={13} height={13} aria-hidden="true" />
      <span className="node-error__message">{message}</span>
    </div>
  );
}
