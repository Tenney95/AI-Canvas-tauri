/**
 * NodeError — 节点报错提示
 *
 * 显示 20 秒后缓慢淡出，淡出结束清除节点的 error 状态（并把 error 状态复位为 idle）。
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';

const VISIBLE_MS = 20000; // 显示时长
const FADE_MS = 1100; // 淡出动画时长（与 CSS transition 对齐）

export default function NodeError({ nodeId, message }: { nodeId: string; message: string }) {
  const updateNodeDataTransient = useAppStore((s) => s.updateNodeDataTransient);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    setFading(false);
    const fadeTimer = setTimeout(() => setFading(true), VISIBLE_MS);
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

  return <div className={`node-error${fading ? ' node-error--fading' : ''}`}>{message}</div>;
}
