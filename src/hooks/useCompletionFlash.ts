/**
 * useCompletionFlash — 监测节点状态从「生成中」跃迁到「完成」的瞬间
 *
 * 当 status 由 'loading' 变为 'success' 时，返回一个短暂为 true 的标志，
 * 供节点在完成时播放一次性的成功动画（边框/内闪）。
 */
import { useEffect, useRef, useState } from 'react';

export function useCompletionFlash(
  status: string | undefined,
  durationMs = 700,
): boolean {
  const prev = useRef(status);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (prev.current === 'loading' && status === 'success') {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), durationMs);
      prev.current = status;
      return () => clearTimeout(t);
    }
    prev.current = status;
  }, [status, durationMs]);

  return flash;
}
