export interface CanvasDisplayClock {
  now: () => number;
  frame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  delay: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancelDelay: (id: ReturnType<typeof setTimeout>) => void;
}

export const CANVAS_DISPLAY_BUDGET = { maxPerFrame: 4, workMs: 3, idleMs: 180 } as const;

interface Job {
  key: object;
  commit: () => void;
  priority: () => number;
  due: number;
  preparation?: boolean;
}

/** 节点结构与媒体显示共用预算；同一 key 只保留最新目标，不持久化。 */
export function createCanvasDisplayScheduler(clock: CanvasDisplayClock = {
  now: () => performance.now(),
  frame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  delay: (callback, ms) => setTimeout(callback, ms),
  cancelDelay: (id) => clearTimeout(id),
}) {
  const jobs = new Map<object, Job>();
  let active = true;
  let interacting = false;
  let quietUntil = 0;
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerDue = Infinity;
  let nextDue = Infinity;
  let ordered: Job[] = [];
  let cursor = 0;
  let dirty = false;
  let lastFrame: number | undefined;
  let frameInterval = 1000 / 60;
  let batchSize: number = CANVAS_DISPLAY_BUDGET.maxPerFrame;
  let healthyFrames = 0;
  let preparing = 0;

  function refreshDue() {
    nextDue = Infinity;
    for (const job of jobs.values()) {
      if (!job.preparation || preparing < 2) nextDue = Math.min(nextDue, job.due);
    }
  }

  function stop() {
    if (frame !== undefined) clock.cancelFrame(frame);
    if (timer !== undefined) clock.cancelDelay(timer);
    frame = undefined;
    timer = undefined;
    timerDue = Infinity;
    lastFrame = undefined;
  }
  function schedule() {
    if (!active || interacting || jobs.size === 0) {
      stop();
      if (jobs.size === 0) { ordered = []; cursor = 0; nextDue = Infinity; }
      return;
    }
    const due = Math.max(quietUntil, nextDue);
    if (!Number.isFinite(due)) { lastFrame = undefined; return; }
    if (timer !== undefined) {
      if (timerDue <= due) return;
      clock.cancelDelay(timer);
      timer = undefined;
    }
    if (frame !== undefined) return;
    const wait = due - clock.now();
    if (wait > 0) {
      lastFrame = undefined;
      timerDue = due;
      timer = clock.delay(() => { timer = undefined; dirty = true; schedule(); }, wait);
    } else frame = clock.frame(pump);
  }
  function pump() {
    frame = undefined;
    const start = clock.now();
    if (!active || interacting || start < quietUntil) { schedule(); return; }
    // 下一帧的间隔包含前一批后的 React commit/布局开销，而不只是通知循环。
    if (lastFrame !== undefined) {
      const elapsed = start - lastFrame;
      if (elapsed > 0) frameInterval = Math.min(frameInterval, Math.max(8, elapsed));
      if (elapsed > frameInterval * 1.5) {
        batchSize = Math.max(1, Math.floor(batchSize / 2));
        healthyFrames = 0;
      } else if (++healthyFrames >= 4) {
        batchSize = Math.min(CANVAS_DISPLAY_BUDGET.maxPerFrame, batchSize + 1);
        healthyFrames = 0;
      }
    }
    lastFrame = start;
    if (dirty) {
      ordered = [...jobs.values()].filter((job) => job.due <= start)
        .map((job) => ({ job, priority: job.priority() }))
        .sort((a, b) => a.priority - b.priority).map(({ job }) => job);
      cursor = 0;
      dirty = false;
    }
    let committed = 0;
    let worked = false;
    try {
      while (active && !interacting && cursor < ordered.length && committed < batchSize) {
        if (worked && clock.now() - start >= CANVAS_DISPLAY_BUDGET.workMs) break;
        const job = ordered[cursor++];
        if (jobs.get(job.key) !== job) continue;
        if (job.preparation && preparing >= 2) continue;
        jobs.delete(job.key);
        // 异步准备只占并发槽位和同步时间预算，不挤占 React/DOM 的提交名额。
        if (!job.preparation) committed++;
        worked = true;
        job.commit();
      }
    } finally {
      refreshDue();
      if (cursor >= ordered.length) dirty = true;
      schedule();
    }
  }

  function enqueue(key: object, commit: () => void, priority: () => number = () => 0, delayMs = 0, preparation = false) {
    const job = { key, commit, priority, due: clock.now() + Math.max(0, delayMs), preparation };
    jobs.set(key, job);
    if (!preparation || preparing < 2) nextDue = Math.min(nextDue, job.due);
    dirty = true;
    schedule();
    return () => {
      if (jobs.get(key) !== job) return;
      jobs.delete(key);
      schedule();
    };
  }
  return {
    enqueue,
    prepare(key: object, work: () => Promise<void>, priority: () => number = () => 0, delayMs = 0) {
      return enqueue(key, () => {
        preparing++;
        void Promise.resolve().then(work).finally(() => {
          preparing--;
          dirty = true;
          refreshDue();
          schedule();
        }).catch(() => { /* 资源失败由调用者处理；释放并发槽位不受失败影响。 */ });
      }, priority, delayMs, true);
    },
    interaction(value: boolean) {
      if (interacting === value) return;
      interacting = value;
      stop();
      if (!value) { quietUntil = clock.now() + CANVAS_DISPLAY_BUDGET.idleMs; dirty = true; schedule(); }
    },
    activate() { active = true; schedule(); },
    deactivate() { active = false; stop(); },
  };
}
