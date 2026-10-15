import { useCallback, useEffect, useRef, useState } from 'react';
import { getComfyRuntimeSnapshot } from '../services/comfyRuntimeService';
import type { ComfyRuntimeLine, ComfyRuntimeSnapshot } from '../types/comfyRuntime';

const MAX_LINES = 2000;
const MAX_CHARACTERS = 1024 * 1024;

function retainRecentLines(lines: ComfyRuntimeLine[]): ComfyRuntimeLine[] {
  let size = 0;
  let first = lines.length;
  while (first > 0 && lines.length - first < MAX_LINES) {
    const length = lines[first - 1].text.length;
    if (size + length > MAX_CHARACTERS) break;
    size += length;
    first -= 1;
  }
  return lines.slice(first);
}

/** 原生按运行 ID 和序号分页；关闭窗口后停止观察，服务独立运行。 */
export function useComfyRuntime(enabled: boolean) {
  const [runtime, setRuntime] = useState<ComfyRuntimeSnapshot | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const cursor = useRef<{ runId: string | null; sequence: number }>({ runId: null, sequence: 0 });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const clearDisplay = useCallback(() => {
    setRuntime((current) => current ? { ...current, lines: [], truncated: false } : current);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      const requested = { ...cursor.current };
      void getComfyRuntimeSnapshot(requested.runId, requested.sequence).then((next) => {
        if (!active) return;
        cursor.current = { runId: next.runId, sequence: next.nextSequence };
        setRuntime((current) => {
          const sameRun = !!current && current.runId === next.runId;
          if (sameRun && !next.lines.length && current.status === next.status && current.port === next.port
            && current.exitCode === next.exitCode && current.message === next.message
            && current.nextSequence === next.nextSequence && !next.truncated) return current;
          const previous = sameRun ? current.lines : [];
          const incoming = sameRun ? next.lines.filter((line) => line.sequence > requested.sequence) : next.lines;
          const combined = [...previous, ...incoming];
          const lines = retainRecentLines(combined);
          return { ...next, lines, truncated: next.truncated || (sameRun && current.truncated) || lines.length < combined.length };
        });
        setError('');
        // 尽快补齐积压分页，不并发发起轮询。
        timer = setTimeout(poll, next.lines.length >= 200 ? 25 : 900);
      }, (cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        timer = setTimeout(poll, 2500);
      });
    };
    poll();
    return () => { active = false; clearTimeout(timer); };
  }, [enabled, revision]);

  return { runtime, error, refresh, clearDisplay };
}
