/**
 * 吉祥物的生命周期片段调度。
 *
 * 把真实的界面事件映射成一次性动画片段：
 * - 窗口失焦 / 页面隐藏 → 睡眠，重新可见 → 醒来
 * - 长时间没有任何输入 → 休息，一有输入就从休息中醒来
 * - 出现等待审批的任务 → 提醒
 *
 * 这些片段只是叠加在常驻状态之上的一次性反馈；业务状态本身仍由
 * useMascotStatus 决定，片段播完后自然回落到它对应的表情。
 */
import { useEffect } from 'react';
import type { RefObject } from 'react';
// 两个 import 都是 type-only：不会把懒加载的 Mascot 组件拖进主包
import type { MascotHandle } from '../components/shared/mascot/Mascot';
import type { MascotClipId } from '../components/shared/mascot/mascotClips';
import { useAppStore } from '../store/useAppStore';

/** 多久没有任何输入就切到休息（毫秒）。 */
const IDLE_TO_REST_MS = 45_000;
/**
 * 输入事件的最小处理间隔（毫秒）。
 * 指针移动触发得非常密集，节流后可以忽略不计地重置计时器。
 */
const ACTIVITY_THROTTLE_MS = 1000;
/** 提醒的最小间隔，避免任务在审批态反复横跳时连续播放（毫秒）。 */
const REMIND_COOLDOWN_MS = 12_000;

function hasPendingApproval(): boolean {
  const state = useAppStore.getState();
  const projectId = state.currentProjectId;
  return state.agentTasks.some(
    (task) => task.projectId === projectId && task.status === 'waiting_approval',
  );
}

export function useMascotLifecycle(
  handleRef: RefObject<MascotHandle | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return undefined;

    const play = (id: MascotClipId) => handleRef.current?.playClip(id) ?? false;

    /* ── 窗口焦点：失焦睡下，回来醒来 ── */
    const handleBlur = () => {
      play('sleep');
    };
    const handleFocus = () => {
      play('wake');
    };
    const handleVisibility = () => {
      // 标签页切到后台与窗口失焦是同一件事，不能只监听 focus/blur
      if (document.hidden) play('sleep');
      else play('wake');
    };

    /* ── 空闲休息：一段时间没有输入就放松下来，一有输入就恢复 ── */
    let idleTimer = 0;
    let resting = false;
    let lastActivityAt = 0;

    const handleActivity = () => {
      const now = performance.now();
      if (now - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
      lastActivityAt = now;

      window.clearTimeout(idleTimer);
      if (resting) {
        resting = false;
        play('wake');
      }
      idleTimer = window.setTimeout(() => {
        // 播不播得成由优先级决定，记下来才知道之后要不要唤醒
        resting = play('rest');
      }, IDLE_TO_REST_MS);
    };

    // 指针移动也算活动：吉祥物本来就跟着光标看，光标一动就该从休息中醒过来
    const activityEvents: (keyof WindowEventMap)[] = [
      'pointermove', 'pointerdown', 'keydown', 'wheel',
    ];
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    // passive：这些监听只用于重置计时器，不阻止默认行为，
    // 指针移动又非常密集，声明 passive 可以让浏览器放心走快路径
    for (const event of activityEvents) {
      window.addEventListener(event, handleActivity, { passive: true });
    }

    // 空闲计时从挂载就开始，不依赖第一次输入
    handleActivity();

    /* ── 待审批任务：只在「从不需审批变成需要审批」时提醒一次 ── */
    let hadPending = hasPendingApproval();
    let lastRemindAt = 0;
    const unsubscribe = useAppStore.subscribe(() => {
      const pending = hasPendingApproval();
      const now = performance.now();
      if (pending && !hadPending && now - lastRemindAt > REMIND_COOLDOWN_MS) {
        lastRemindAt = now;
        play('remind');
      }
      hadPending = pending;
    });

    return () => {
      window.clearTimeout(idleTimer);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
      for (const event of activityEvents) window.removeEventListener(event, handleActivity);
      unsubscribe();
    };
  }, [enabled, handleRef]);
}
