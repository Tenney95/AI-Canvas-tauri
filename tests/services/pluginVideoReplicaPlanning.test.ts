import { describe, expect, it } from 'vitest';
import { planPluginVideoReplica, type PluginVideoReplicaPlan } from '../../src/services/plugins/pluginVideoReplicaPlanning';
import type { VideoModelCapability } from '../../src/types/aiTypes';
import { resolveVideoModelCapability } from '../../src/services/ai/videoModelCapabilityResolver';
import { useAppStore } from '../../src/store/useAppStore';

const capability = (overrides: Partial<VideoModelCapability> = {}): VideoModelCapability => ({
  operations: ['text-to-video', 'image-to-video', 'video-to-video'], minDuration: 4, maxDuration: 30,
  maxImageReferences: 9, maxVideoReferences: 10, maxAudioReferences: 10, ...overrides,
});

function expectFullCoverage(plan: PluginVideoReplicaPlan): void {
  expect(plan.segments[0].inPoint).toBe(0);
  expect(plan.segments.at(-1)!.outPoint).toBe(plan.duration);
  for (const [index, segment] of plan.segments.entries()) {
    expect(segment.outPoint).toBeGreaterThan(segment.inPoint);
    if (index > 0) expect(segment.inPoint).toBe(plan.segments[index - 1].outPoint);
    if (segment.references.length > 0) {
      expect(segment.references[0].inPoint).toBe(segment.inPoint);
      expect(segment.references.at(-1)!.outPoint).toBe(segment.outPoint);
      for (const [referenceIndex, reference] of segment.references.entries()) {
        expect(reference.outPoint - reference.inPoint).toBeLessThanOrEqual(15);
        expect(reference.referenceDuration).toBeGreaterThanOrEqual(reference.outPoint - reference.inPoint - 1e-8);
        if (referenceIndex > 0) expect(reference.inPoint).toBe(segment.references[referenceIndex - 1].outPoint);
      }
    }
  }
}

describe('pluginVideoReplicaPlanning', () => {
  it('plans the complete minute as two 30-second or four 15-second generations', () => {
    const sd = planPluginVideoReplica({ duration: 60, capability: capability(), hasAudio: true });
    expect(sd.generationCount).toBe(2);
    expect(sd.segments.map((segment) => segment.generationDuration)).toEqual([30, 30]);
    expect(sd.segments[0].references.map((reference) => reference.referenceDuration)).toEqual([15, 15]);
    const h3 = planPluginVideoReplica({ duration: 60, capability: capability({ maxDuration: 15, maxVideoReferences: 3, maxAudioReferences: 3 }) });
    expect(h3.generationCount).toBe(4);
    expectFullCoverage(sd);
    expectFullCoverage(h3);
  });

  it('keeps manual cut points and splits only their oversized intervals', () => {
    const plan = planPluginVideoReplica({ duration: 60, cuts: [12, 45], capability: capability() });
    expect(plan.segments.map(({ inPoint, outPoint }) => [inPoint, outPoint])).toEqual([[0, 12], [12, 42], [42, 45], [45, 60]]);
    expect(plan.segments[2].generationDuration).toBe(4);
    expectFullCoverage(plan);
  });

  it('rejects invalid or reordered cuts instead of silently sorting them', () => {
    for (const cuts of [[0], [60], [30, 20], [20, 20], [NaN], [-1]]) {
      expect(() => planPluginVideoReplica({ duration: 60, cuts, capability: capability() })).toThrow('手动切点');
    }
  });

  it('keeps a short tail while selecting a legal discrete generation duration', () => {
    const plan = planPluginVideoReplica({ duration: 17.2, capability: capability({ durations: [5, 10, 15] }) });
    expect(plan.segments.map(({ inPoint, outPoint, generationDuration }) => [inPoint, outPoint, generationDuration])).toEqual([[0, 15, 15], [15, 17.2, 5]]);
    expectFullCoverage(plan);
  });

  it('obeys exclusive reference limits while retaining a 30-second output segment', () => {
    const declared = resolveVideoModelCapability('sora2u/seedance-2.5', useAppStore.getState().config)!;
    const plan = planPluginVideoReplica({ duration: 60, capability: declared, hasAudio: true });
    expect(plan.generationCount).toBe(2);
    expect(plan.segments[0].references.map((reference) => reference.referenceDuration)).toEqual([10, 10, 10]);
    expect(plan.segments[0].audioReferences.map((reference) => reference.referenceDuration)).toEqual([10, 10, 10]);
    expectFullCoverage(plan);
  });

  it('respects control count and aggregate reference duration constraints', () => {
    const plan = planPluginVideoReplica({ duration: 60, controls: ['depth', 'pose', 'canny'], capability: capability({
      maxVideoReferences: 3, inputConstraints: { referenceVideo: { totalDurationSeconds: { max: 24 } } },
    }) });
    expect(plan.segments[0].outPoint).toBe(8);
    expect(plan.generationCount).toBe(8);
    expectFullCoverage(plan);
  });

  it('pads short audio references without changing the original timeline', () => {
    const plan = planPluginVideoReplica({ duration: 2, hasAudio: true, capability: capability({
      inputConstraints: { referenceAudio: { durationSeconds: { min: 3, max: 15, maxExclusive: true } } },
    }) });
    expect(plan.segments[0].audioReferences[0]).toMatchObject({ inPoint: 0, outPoint: 2, referenceDuration: 3 });
    expect(plan.segments[0].generationDuration).toBe(4);
  });

  it('preserves the automatic generation-duration sentinel for video operations', () => {
    const declared = resolveVideoModelCapability('volcengine/doubao-seedance-2-5', useAppStore.getState().config)!;
    const plan = planPluginVideoReplica({ duration: 60, capability: declared });
    expect(plan.segments.map((segment) => segment.generationDuration)).toEqual([-1, -1]);
    expectFullCoverage(plan);
    const tail = planPluginVideoReplica({ duration: 31, capability: declared });
    expect(tail.segments[1].generationDuration).toBe(-1);
    expect(tail.segments[1].references[0]).toMatchObject({ inPoint: 30, outPoint: 31, referenceDuration: 4 });
  });

  it('does not silently drop original audio when reference support is absent', () => {
    const plan = planPluginVideoReplica({ duration: 10, capability: capability({ maxAudioReferences: 0 }), hasAudio: true });
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('原声');
    expect(plan.segments[0].audioReferences).toEqual([]);
  });

  it('rejects depth input before generation for image-only models', () => {
    expect(() => planPluginVideoReplica({ duration: 60, capability: capability({ operations: ['text-to-video', 'image-to-video'], maxVideoReferences: 0 }) })).toThrow('video-to-video');
    const frames = planPluginVideoReplica({ duration: 60, controls: [], capability: capability({ operations: ['text-to-video', 'image-to-video'], maxVideoReferences: 0, maxDuration: 15 }) });
    expect(frames.generationCount).toBe(4);
  });

  it('checks declared resolution and duration metadata without invented defaults', () => {
    expect(() => planPluginVideoReplica({ duration: 5, resolution: '1080p', capability: capability({ resolutions: ['720p'] }) })).toThrow('分辨率');
    expect(() => planPluginVideoReplica({ duration: 5, capability: { maxVideoReferences: 1 } })).toThrow('最大生成时长');
    expect(planPluginVideoReplica({ duration: 5, capability: capability({ inputConstraints: { promptMinCharacters: 1_000_000_000 } }) }).generationCount).toBe(1);
  });

  it('honors user segment limits and fails on whole-task limits without truncation', () => {
    const plan = planPluginVideoReplica({ duration: 60, maxSegmentSeconds: 12, capability: capability() });
    expect(plan.generationCount).toBe(5);
    expectFullCoverage(plan);
    expect(() => planPluginVideoReplica({ duration: 300.01, capability: capability() })).toThrow('300');
    expect(() => planPluginVideoReplica({ duration: 65, maxSegmentSeconds: 1, capability: capability() })).toThrow('64');
    expect(() => planPluginVideoReplica({ duration: 60, maxSegmentSeconds: 0, capability: capability() })).toThrow('每段');
  });
});
