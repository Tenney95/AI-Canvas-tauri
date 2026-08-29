import { describe, expect, it } from 'vitest';
import {
  MASCOT_CLIPS,
  advanceClip,
  canPlayClip,
  createClipState,
  isClipFinished,
  isGazeLocked,
  requestClip,
  sampleClipExpression,
  startClip,
  stopClip,
  type ClipPlaybackState,
  type MascotClipId,
} from '../../src/components/shared/mascot/mascotClips';
import { EXPRESSIONS } from '../../src/components/shared/mascot/mascotExpressions';

const IDS = Object.keys(MASCOT_CLIPS) as MascotClipId[];

/** 推进直到片段结束，返回实际耗时。上限防止常驻片段造成死循环。 */
function playToEnd(state: ClipPlaybackState): number {
  let spent = 0;
  while (state.clipId && spent < 30) {
    advanceClip(state, 1 / 60);
    spent += 1 / 60;
  }
  return spent;
}

/** 播完一个一次性片段，返回耗时。 */
function measureDuration(id: MascotClipId): number {
  const state = createClipState();
  startClip(state, id);
  return playToEnd(state);
}

describe('mascotClips', () => {
  it('declares keyframes in order starting at zero', () => {
    for (const id of IDS) {
      const { keyframes } = MASCOT_CLIPS[id];
      expect(keyframes.length).toBeGreaterThan(0);
      expect(keyframes[0].at).toBe(0);
      for (let index = 1; index < keyframes.length; index += 1) {
        expect(keyframes[index].at).toBeGreaterThan(keyframes[index - 1].at);
      }
    }
  });

  it('returns to neutral after every one-shot clip', () => {
    // 一次性片段必须以 neutral 收尾，否则播完会卡在一个夸张的表情上
    for (const id of IDS) {
      const clip = MASCOT_CLIPS[id];
      if (!Number.isFinite(clip.duration)) continue;
      const last = clip.keyframes[clip.keyframes.length - 1];
      expect(last.expression).toBe('neutral');
      expect(last.at).toBeLessThan(clip.duration);
    }
  });

  it('gives reaction clips a higher priority than lingering states', () => {
    // 睡眠 / 休息这类常驻状态必须能被一次性反应打断
    for (const reaction of ['excited', 'surprised', 'angry', 'remind'] as const) {
      expect(MASCOT_CLIPS[reaction].priority).toBeGreaterThan(MASCOT_CLIPS.sleep.priority);
      expect(MASCOT_CLIPS[reaction].priority).toBeGreaterThan(MASCOT_CLIPS.rest.priority);
    }
    // 醒来要能盖掉睡眠
    expect(MASCOT_CLIPS.wake.priority).toBeGreaterThan(MASCOT_CLIPS.sleep.priority);
  });

  it('lets a higher priority clip interrupt and blocks a lower one', () => {
    const state = createClipState();
    startClip(state, 'sleep');

    expect(requestClip(state, 'excited')).toBe(true);
    expect(state.clipId).toBe('excited');

    // 正在播高优先级反应时，低优先级的休息不能插进来
    expect(requestClip(state, 'rest')).toBe(false);
    expect(state.clipId).toBe('excited');
  });

  it('does not let an equal priority clip interrupt itself', () => {
    // 同优先级互相顶掉会造成抖动，所以要求严格更高才能打断
    const state = createClipState();
    startClip(state, 'sleep');
    expect(canPlayClip(state, 'sleep')).toBe(false);
  });

  it('always allows a clip once the previous one has finished', () => {
    const state = createClipState();
    startClip(state, 'angry');
    playToEnd(state);
    expect(state.clipId).toBeNull();
    expect(requestClip(state, 'rest')).toBe(true);
  });

  it('ends one-shot clips and keeps lingering ones playing', () => {
    expect(MASCOT_CLIPS.excited.duration).toBeLessThan(2);
    expect(measureDuration('excited')).toBeLessThan(2);

    for (const id of ['sleep', 'rest', 'sleepy'] as const) {
      expect(MASCOT_CLIPS[id].duration).toBe(Number.POSITIVE_INFINITY);
      const state = createClipState();
      startClip(state, id);
      for (let frame = 0; frame < 600; frame += 1) advanceClip(state, 1 / 60);
      expect(state.clipId).toBe(id);
    }
  });

  it('samples the keyframe that is active at the current time', () => {
    const state = createClipState();
    startClip(state, 'wake');
    expect(sampleClipExpression(state, 'neutral')).toBe(EXPRESSIONS.wake);

    // 越过第二个关键帧之后应当切到 neutral
    advanceClip(state, 0.5);
    expect(state.elapsed).toBeGreaterThan(0.45);
    expect(sampleClipExpression(state, 'neutral')).toBe(EXPRESSIONS.neutral);
  });

  it('falls back to the base expression when no clip is playing', () => {
    const state = createClipState();
    expect(sampleClipExpression(state, 'thinking')).toBe(EXPRESSIONS.thinking);

    startClip(state, 'rest');
    expect(sampleClipExpression(state, 'thinking')).toBe(EXPRESSIONS.rest);

    stopClip(state);
    expect(sampleClipExpression(state, 'thinking')).toBe(EXPRESSIONS.thinking);
  });

  it('locks the gaze only for clips that mean looking away', () => {
    const state = createClipState();
    // 没有片段播放时视线正常跟随
    expect(isGazeLocked(state)).toBe(false);

    for (const id of ['sleep', 'sleepy', 'rest'] as const) {
      startClip(state, id);
      expect(isGazeLocked(state)).toBe(true);
    }

    // 反应类片段必须能看鼠标，否则醒来后眼神是死的
    for (const id of ['wake', 'remind', 'excited', 'surprised', 'suspicious', 'angry'] as const) {
      startClip(state, id);
      expect(isGazeLocked(state)).toBe(false);
    }
  });

  it('releases the gaze lock when a lingering clip is replaced', () => {
    // sleep / rest 是常驻片段，只能靠更高优先级的片段顶掉来解锁
    const state = createClipState();
    startClip(state, 'sleep');
    expect(isGazeLocked(state)).toBe(true);
    startClip(state, 'wake');
    expect(isGazeLocked(state)).toBe(false);
  });

  it('releases the gaze lock once the clip state is cleared', () => {
    // 三个锁视线的片段都是常驻的，所以要么被顶掉、要么被显式清空才会解锁
    const state = createClipState();
    startClip(state, 'sleepy');
    expect(isGazeLocked(state)).toBe(true);
    stopClip(state);
    expect(isGazeLocked(state)).toBe(false);
  });

  it('reports finished state consistently', () => {
    const state = createClipState();
    expect(isClipFinished(state)).toBe(true);

    startClip(state, 'sleep');
    expect(isClipFinished(state)).toBe(false);

    startClip(state, 'surprised');
    expect(isClipFinished(state)).toBe(false);
    // 正好推进到时长边界即视为结束
    advanceClip(state, MASCOT_CLIPS.surprised.duration);
    expect(isClipFinished(state)).toBe(true);
  });
});
