import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TRANSFORM,
  evaluateTransitionAlpha,
  evaluateVolume,
  getActiveClips,
  getClipEnd,
  hasMixedSources,
  needsCompositing,
  type VideoEditorClip,
  type VideoEditorTrack,
} from '../../src/types/videoEditor';
import { computeDrawRect, renderFrameAt } from '../../src/services/videoCompositor';
import { resolveCompositeAudioMode } from '../../src/services/videoEditorMediaService';
import {
  createTrack,
  moveTrack,
  placeClipAt,
  removeTrack,
  removeVolumePoint,
  setVolumePoint,
} from '../../src/components/videoEditor/timelineOps';

function clip(overrides: Partial<VideoEditorClip> & { id: string }): VideoEditorClip {
  return {
    kind: 'video',
    fileName: `${overrides.id}.mp4`,
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 5,
    ...overrides,
  };
}

function videoTrack(clips: VideoEditorClip[]): VideoEditorTrack {
  return { id: 'v1', kind: 'video', name: '视频轨 1', clips };
}

describe('needsCompositing', () => {
  it('mixes an independent audio track even when the main video needs no visual changes', () => {
    const main = videoTrack([clip({ id: 'main' })]);
    const audio: VideoEditorTrack = { id: 'voice', kind: 'audio', name: '配音', clips: [clip({ id: 'voice' })] };
    expect(needsCompositing([main, audio])).toBe(true);
    expect(needsCompositing([main, { ...audio, muted: true }])).toBe(false);
    expect(needsCompositing([main, { ...audio, hidden: true }])).toBe(false);
    expect(needsCompositing([main, { ...audio, clips: [] }])).toBe(false);
  });
  it('stays on the lossless path for a plain single-track timeline', () => {
    expect(needsCompositing([videoTrack([clip({ id: 'a' }), clip({ id: 'b' })])])).toBe(false);
  });

  it('switches to compositing once a second video track exists', () => {
    expect(needsCompositing([
      videoTrack([clip({ id: 'a' })]),
      { id: 'v2', kind: 'video', name: '叠加轨 1', overlay: true, clips: [] },
    ])).toBe(true);
  });

  it('switches to compositing for transforms, transitions and images', () => {
    expect(needsCompositing([videoTrack([
      clip({ id: 'a', transform: { ...DEFAULT_TRANSFORM, scale: 0.4 } }),
    ])])).toBe(true);

    expect(needsCompositing([videoTrack([
      clip({ id: 'a', transitionIn: { kind: 'dissolve', duration: 0.5 } }),
    ])])).toBe(true);

    expect(needsCompositing([videoTrack([clip({ id: 'a', kind: 'image' })])])).toBe(true);
    expect(needsCompositing([videoTrack([clip({
      id: 'text',
      kind: 'text',
      textStyle: {
        content: '标题',
        fontFamily: 'sans-serif',
        fontSize: 64,
        color: '#fff',
        fontWeight: 600,
        align: 'center',
      },
    })])])).toBe(true);
  });

  it('ignores a no-op transform and a none transition', () => {
    expect(needsCompositing([videoTrack([
      clip({ id: 'a', transform: { ...DEFAULT_TRANSFORM } }),
      clip({ id: 'b', transitionIn: { kind: 'none', duration: 0 } }),
    ])])).toBe(false);
  });

  it('ignores hidden tracks', () => {
    expect(needsCompositing([
      videoTrack([clip({ id: 'a' })]),
      { id: 'v2', kind: 'video', name: '叠加轨', hidden: true, clips: [clip({ id: 'b' })] },
    ])).toBe(false);
  });
});

describe('getActiveClips / getClipEnd', () => {
  const track = videoTrack([
    clip({ id: 'a', timelineStart: 0, sourceOut: 4 }),
    clip({ id: 'b', timelineStart: 2, sourceOut: 4 }),
  ]);

  it('returns every clip covering the instant, so overlays stack', () => {
    expect(getActiveClips(track, 3).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(getActiveClips(track, 1).map((entry) => entry.id)).toEqual(['a']);
  });

  it('treats the clip end as exclusive', () => {
    expect(getClipEnd(track.clips[0])).toBe(4);
    expect(getActiveClips(track, 4).map((entry) => entry.id)).toEqual(['b']);
  });
});

describe('evaluateTransitionAlpha', () => {
  const dissolving = clip({ id: 'a', transitionIn: { kind: 'dissolve', duration: 1 } });

  it('ramps from 0 to 1 across the transition', () => {
    expect(evaluateTransitionAlpha(dissolving, 0)).toBe(0);
    expect(evaluateTransitionAlpha(dissolving, 0.5)).toBeCloseTo(0.5);
    expect(evaluateTransitionAlpha(dissolving, 1)).toBe(1);
  });

  it('is fully opaque past the transition and for hard cuts', () => {
    expect(evaluateTransitionAlpha(dissolving, 3)).toBe(1);
    expect(evaluateTransitionAlpha(clip({ id: 'b' }), 0)).toBe(1);
    expect(evaluateTransitionAlpha(
      clip({ id: 'c', transitionIn: { kind: 'none', duration: 1 } }),
      0,
    )).toBe(1);
  });
});

describe('evaluateVolume', () => {
  it('falls back to the constant clip gain', () => {
    expect(evaluateVolume(clip({ id: 'a' }), 1)).toBe(1);
    expect(evaluateVolume(clip({ id: 'a', volume: 0.5 }), 1)).toBe(0.5);
  });

  it('interpolates linearly between envelope points', () => {
    const faded = clip({
      id: 'a',
      volumePoints: [{ t: 0, gain: 0 }, { t: 2, gain: 1 }],
    });
    expect(evaluateVolume(faded, 0)).toBe(0);
    expect(evaluateVolume(faded, 1)).toBeCloseTo(0.5);
    expect(evaluateVolume(faded, 2)).toBe(1);
  });

  it('holds the edge values outside the envelope range', () => {
    const faded = clip({ id: 'a', volumePoints: [{ t: 1, gain: 0.25 }, { t: 2, gain: 1 }] });
    expect(evaluateVolume(faded, 0)).toBe(0.25);
    expect(evaluateVolume(faded, 9)).toBe(1);
  });

  it('multiplies the envelope by the clip gain', () => {
    const faded = clip({ id: 'a', volume: 0.5, volumePoints: [{ t: 0, gain: 1 }] });
    expect(evaluateVolume(faded, 0)).toBe(0.5);
  });
});

describe('computeDrawRect', () => {
  const canvas = { width: 1920, height: 1080 };

  it('fills the canvas at scale 1 while preserving aspect ratio', () => {
    const rect = computeDrawRect({ width: 1920, height: 1080 }, canvas, DEFAULT_TRANSFORM);
    expect(rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('letterboxes a mismatched aspect ratio instead of stretching it', () => {
    const rect = computeDrawRect({ width: 1080, height: 1080 }, canvas, DEFAULT_TRANSFORM);
    expect(rect.width).toBe(1080);
    expect(rect.height).toBe(1080);
    expect(rect.x).toBe(420);
  });

  it('places a picture-in-picture layer by its centre', () => {
    const rect = computeDrawRect({ width: 1920, height: 1080 }, canvas, {
      ...DEFAULT_TRANSFORM,
      x: 0.8,
      y: 0.8,
      scale: 0.25,
    });
    expect(rect.width).toBe(480);
    expect(rect.x + rect.width / 2).toBeCloseTo(1536);
    expect(rect.y + rect.height / 2).toBeCloseTo(864);
  });
});

describe('文字片段合成', () => {
  it('draws active text directly onto the export canvas without a media source', async () => {
    const fillText = vi.fn();
    const context = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      fillText,
      globalAlpha: 1,
      fillStyle: '',
      font: '',
      textAlign: 'center',
      textBaseline: 'middle',
      shadowColor: '',
      shadowBlur: 0,
    } as unknown as CanvasRenderingContext2D;
    const textClip = clip({
      id: 'title',
      kind: 'text',
      sourceOut: 3,
      textStyle: {
        content: '第一行\n第二行',
        fontFamily: 'sans-serif',
        fontSize: 60,
        color: '#ffffff',
        fontWeight: 700,
        align: 'center',
      },
    });

    await renderFrameAt(
      context,
      { width: 1920, height: 1080 },
      [{ id: 'text-track', kind: 'video', name: '文字与贴图', overlay: true, clips: [textClip] }],
      1,
      () => undefined,
    );

    expect(fillText).toHaveBeenCalledTimes(2);
    expect(fillText).toHaveBeenNthCalledWith(1, '第一行', 0, expect.any(Number));
    expect(fillText).toHaveBeenNthCalledWith(2, '第二行', 0, expect.any(Number));
  });
});

describe('交叠淡入', () => {
  /** 记录每次 drawImage 时的图源与不透明度 */
  function recordingContext() {
    const draws: { image: unknown; alpha: number }[] = [];
    const context = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      drawImage: vi.fn(function drawImage(this: { globalAlpha: number }, image: unknown) {
        draws.push({ image, alpha: context.globalAlpha });
      }),
      globalAlpha: 1,
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D & { globalAlpha: number };
    return { context, draws };
  }

  /** 两段首尾相接的图片片段，后一段带 1s 交叠淡入 */
  function dissolvingTrack(): { track: VideoEditorTrack; bitmaps: Record<string, object> } {
    const bitmaps = { a: { tag: 'a' }, b: { tag: 'b' } };
    const track = videoTrack([
      clip({ id: 'a', kind: 'image', sourceOut: 4 }),
      clip({
        id: 'b',
        kind: 'image',
        timelineStart: 4,
        sourceOut: 4,
        transitionIn: { kind: 'dissolve', duration: 1 },
      }),
    ]);
    return { track, bitmaps };
  }

  const resolveBitmaps = (bitmaps: Record<string, object>) => (target: VideoEditorClip) => (
    bitmaps[target.id as keyof typeof bitmaps]
      ? { bitmap: bitmaps[target.id] as unknown as ImageBitmap, width: 1920, height: 1080 }
      : undefined
  );

  it('keeps drawing the outgoing clip underneath while the next one fades in', async () => {
    const { context, draws } = recordingContext();
    const { track, bitmaps } = dissolvingTrack();

    // 4.5s：转场进行到一半
    await renderFrameAt(context, { width: 1920, height: 1080 }, [track], 4.5, resolveBitmaps(bitmaps));

    expect(draws).toHaveLength(2);
    // 前一段铺满在下，后一段半透明压上去 —— 这才是「交叠」
    expect(draws[0]).toEqual({ image: bitmaps.a, alpha: 1 });
    expect(draws[1].image).toBe(bitmaps.b);
    expect(draws[1].alpha).toBeCloseTo(0.5);
  });

  it('leaves the first clip of a track without an underlay', async () => {
    const { context, draws } = recordingContext();
    const bitmaps = { a: { tag: 'a' } };
    const track = videoTrack([
      clip({ id: 'a', kind: 'image', sourceOut: 4, transitionIn: { kind: 'dissolve', duration: 1 } }),
    ]);

    await renderFrameAt(context, { width: 1920, height: 1080 }, [track], 0.5, resolveBitmaps(bitmaps));

    expect(draws).toHaveLength(1);
    expect(draws[0].image).toBe(bitmaps.a);
  });

  it('ignores a preceding clip that is not butted up against this one', async () => {
    const { context, draws } = recordingContext();
    const bitmaps = { a: { tag: 'a' }, b: { tag: 'b' } };
    const overlay: VideoEditorTrack = {
      id: 'o1',
      kind: 'video',
      name: '叠加轨 1',
      overlay: true,
      clips: [
        clip({ id: 'a', kind: 'image', sourceOut: 2 }),
        // 和前一段之间隔着 3 秒空白，不构成交叠关系
        clip({
          id: 'b',
          kind: 'image',
          timelineStart: 5,
          sourceOut: 2,
          transitionIn: { kind: 'dissolve', duration: 1 },
        }),
      ],
    };

    await renderFrameAt(context, { width: 1920, height: 1080 }, [overlay], 5.5, resolveBitmaps(bitmaps));

    expect(draws).toHaveLength(1);
    expect(draws[0].image).toBe(bitmaps.b);
  });

  it('samples the outgoing clip past its out point rather than repeating its last kept frame', async () => {
    const requested: number[] = [];
    const { context } = recordingContext();
    const track = videoTrack([
      clip({ id: 'a', sourceIn: 1, sourceOut: 5 }),
      clip({
        id: 'b',
        timelineStart: 4,
        sourceOut: 4,
        transitionIn: { kind: 'dissolve', duration: 1 },
      }),
    ]);

    await renderFrameAt(context, { width: 1920, height: 1080 }, [track], 4.25, (target) => ({
      width: 1920,
      height: 1080,
      sink: {
        getSample: async (time: number) => {
          if (target.id === 'a') requested.push(time);
          return null;
        },
      } as never,
    }));

    // 出点 5s 之后再走 0.25s：底画面必须继续往前放，而不是卡在出点那一帧
    expect(requested).toEqual([5.25]);
  });
});

describe('轨道管理', () => {
  const base: VideoEditorTrack[] = [videoTrack([clip({ id: 'a' })])];

  it('marks the second and later video tracks as overlays', () => {
    expect(createTrack('video', base).overlay).toBe(true);
    expect(createTrack('video', []).overlay).toBe(false);
    expect(createTrack('audio', base).kind).toBe('audio');
  });

  it('refuses to delete the main video track', () => {
    expect(removeTrack(base, 'v1')).toBe(base);
  });

  it('deletes overlay and audio tracks', () => {
    const withOverlay = [...base, createTrack('video', base)];
    expect(removeTrack(withOverlay, withOverlay[1].id)).toHaveLength(1);
  });

  it('never reorders a track below the main video track', () => {
    const overlay = createTrack('video', base);
    const tracks = [...base, overlay];
    expect(moveTrack(tracks, overlay.id, -1)).toBe(tracks);
    expect(moveTrack(tracks, overlay.id, 1)).toBe(tracks);
  });

  it('swaps two overlay tracks', () => {
    const first = { ...createTrack('video', base), id: 'o1' };
    const second = { ...createTrack('video', base), id: 'o2' };
    const tracks = [...base, first, second];
    expect(moveTrack(tracks, first.id, 1).map((track) => track.id)).toEqual(['v1', 'o2', 'o1']);
  });
});

describe('placeClipAt', () => {
  it('moves an overlay clip freely without packing', () => {
    const clips = [clip({ id: 'a', timelineStart: 0 })];
    expect(placeClipAt(clips, 'a', 4.5)[0].timelineStart).toBe(4.5);
  });

  it('never lets a clip start before zero', () => {
    expect(placeClipAt([clip({ id: 'a' })], 'a', -3)[0].timelineStart).toBe(0);
  });
});

describe('音量包络编辑', () => {
  it('adds points in time order', () => {
    let target = setVolumePoint(clip({ id: 'a' }), 2, 0.5);
    target = setVolumePoint(target, 0, 1);
    expect(target.volumePoints).toEqual([{ t: 0, gain: 1 }, { t: 2, gain: 0.5 }]);
  });

  it('replaces a point at the same time instead of duplicating it', () => {
    let target = setVolumePoint(clip({ id: 'a' }), 1, 0.2);
    target = setVolumePoint(target, 1, 0.9);
    expect(target.volumePoints).toEqual([{ t: 1, gain: 0.9 }]);
  });

  it('drops the envelope entirely once the last point is removed', () => {
    const target = setVolumePoint(clip({ id: 'a' }), 1, 0.2);
    expect(removeVolumePoint(target, 1).volumePoints).toBeUndefined();
  });
});

describe('hasMixedSources', () => {
  const uhd = { codec: 'avc', width: 3840, height: 2160 };
  const fhd = { codec: 'avc', width: 1920, height: 1080 };

  it('flags a resolution mismatch, which blocks direct concatenation', () => {
    // 正是实测撞到的场景：avc 1920×1080 与 avc 3840×2160 混在一条时间轴
    expect(hasMixedSources([uhd, fhd])).toBe(true);
  });

  it('flags a codec mismatch at the same resolution', () => {
    expect(hasMixedSources([fhd, { ...fhd, codec: 'hevc' }])).toBe(true);
  });

  it('accepts identical sources', () => {
    expect(hasMixedSources([fhd, { ...fhd }, { ...fhd }])).toBe(false);
  });

  it('stays neutral while probes are still missing', () => {
    expect(hasMixedSources([])).toBe(false);
    expect(hasMixedSources([fhd])).toBe(false);
    expect(hasMixedSources([fhd, null, undefined])).toBe(false);
    // 未探测完的片段不该让判断提前倒向合成
    expect(hasMixedSources([fhd, { codec: 'avc', width: 0, height: 0 }])).toBe(false);
  });
});

describe('resolveCompositeAudioMode', () => {
  const audioClip = (over: Partial<VideoEditorClip> & { id: string }) => clip(over);
  const withAudio = (clips: VideoEditorClip[]): VideoEditorTrack[] => [videoTrack(clips)];

  const fakeInput = (codec = 'aac', sampleRate = 48000, channels = 2) => ({
    getPrimaryAudioTrack: async () => ({
      getCodec: async () => codec,
      getDecoderConfig: async () => ({ codec, sampleRate, numberOfChannels: channels }),
    }),
  }) as unknown as Parameters<typeof resolveCompositeAudioMode>[1] extends
    (clip: VideoEditorClip) => infer R ? NonNullable<R> : never;

  const resolver = (input = fakeInput()) => () => input;

  afterEach(() => { vi.unstubAllGlobals(); });

  it('mixes when the browser has an AudioEncoder', async () => {
    vi.stubGlobal('AudioEncoder', class {});
    const result = await resolveCompositeAudioMode(
      withAudio([audioClip({ id: 'a' })]),
      resolver(),
    );
    expect(result.mode).toBe('encode');
  });

  it('falls back to packet copy when AudioEncoder is missing', async () => {
    // WebKit 至今没有 AudioEncoder，这是 macOS 上的实际情形
    vi.stubGlobal('AudioEncoder', undefined);
    const result = await resolveCompositeAudioMode(
      withAudio([
        audioClip({ id: 'a', timelineStart: 0, sourceOut: 4 }),
        audioClip({ id: 'b', timelineStart: 4, sourceOut: 4 }),
      ]),
      resolver(),
    );
    expect(result.mode).toBe('copy');
  });

  it('mixes into PCM instead of copying when clips overlap', async () => {
    // 重叠必须混音，直通不可行；但 PCM 不需要 AudioEncoder，音频照样保得住
    vi.stubGlobal('AudioEncoder', undefined);
    const result = await resolveCompositeAudioMode(
      withAudio([
        audioClip({ id: 'a', timelineStart: 0, sourceOut: 4 }),
        audioClip({ id: 'b', timelineStart: 2, sourceOut: 4 }),
      ]),
      resolver(),
    );
    expect(result.mode).toBe('pcm');
    expect(result.reason).toContain('重叠');
  });

  it('mixes into PCM instead of copying when a volume change is requested', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    expect((await resolveCompositeAudioMode(
      withAudio([audioClip({ id: 'a', volume: 0.5 })]),
      resolver(),
    )).mode).toBe('pcm');

    expect((await resolveCompositeAudioMode(
      withAudio([audioClip({ id: 'a', volumePoints: [{ t: 0, gain: 0 }] })]),
      resolver(),
    )).mode).toBe('pcm');
  });

  it('reports no audio for an empty or fully muted timeline', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    expect((await resolveCompositeAudioMode([videoTrack([])], resolver())).mode).toBe('none');
    expect((await resolveCompositeAudioMode(
      [{ ...videoTrack([audioClip({ id: 'a' })]), muted: true }],
      resolver(),
    )).mode).toBe('none');
  });

  it('skips image clips, which carry no audio', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    const result = await resolveCompositeAudioMode(
      withAudio([audioClip({ id: 'a', kind: 'image' })]),
      resolver(),
    );
    expect(result.mode).toBe('none');
  });
});

describe('音轨保留策略', () => {
  // 直通拼接要求各段音频解码参数一致，用签名比较；这里覆盖判据本身
  const signature = (codec: string, rate: number, channels: number) =>
    `${codec}|${rate}|${channels}`;

  it('treats identical audio parameters as concatenable', () => {
    const all = [
      signature('mp4a.40.2', 48000, 2),
      signature('mp4a.40.2', 48000, 2),
    ];
    expect(all.every((entry) => entry === all[0])).toBe(true);
  });

  it('rejects a sample rate or channel mismatch', () => {
    expect(signature('mp4a.40.2', 44100, 2)).not.toBe(signature('mp4a.40.2', 48000, 2));
    expect(signature('mp4a.40.2', 48000, 1)).not.toBe(signature('mp4a.40.2', 48000, 2));
  });
});

describe('resolveCompositeAudioMode 的 PCM 兜底', () => {
  const resolver = () => ({
    getPrimaryAudioTrack: async () => ({
      getCodec: async () => 'aac',
      getDecoderConfig: async () => ({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 }),
    }),
  }) as never;

  afterEach(() => { vi.unstubAllGlobals(); });

  it('mixes into PCM when a volume change rules out packet copy', async () => {
    // 没有 AudioEncoder 也不该丢音频：PCM 走 mediabunny 自带的软件编码器
    vi.stubGlobal('AudioEncoder', undefined);
    const result = await resolveCompositeAudioMode(
      [{ id: 'v1', kind: 'video', name: 'v', clips: [clip({ id: 'a', volume: 0.5 })] }],
      resolver,
    );
    expect(result.mode).toBe('pcm');
    expect(result.reason).toContain('音量');
  });

  it('mixes into PCM when clips overlap', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    const result = await resolveCompositeAudioMode(
      [{
        id: 'v1', kind: 'video', name: 'v',
        clips: [
          clip({ id: 'a', timelineStart: 0, sourceOut: 4 }),
          clip({ id: 'b', timelineStart: 2, sourceOut: 4 }),
        ],
      }],
      resolver,
    );
    expect(result.mode).toBe('pcm');
    expect(result.reason).toContain('重叠');
  });

  it('still prefers lossless packet copy when nothing needs mixing', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    const result = await resolveCompositeAudioMode(
      [{
        id: 'v1', kind: 'video', name: 'v',
        clips: [
          clip({ id: 'a', timelineStart: 0, sourceOut: 4 }),
          clip({ id: 'b', timelineStart: 4, sourceOut: 4 }),
        ],
      }],
      resolver,
    );
    expect(result.mode).toBe('copy');
  });

  it('only reports none when there is genuinely no audio', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    const result = await resolveCompositeAudioMode(
      [{ id: 'v1', kind: 'video', name: 'v', clips: [clip({ id: 'a' })] }],
      (() => ({ getPrimaryAudioTrack: async () => null })) as never,
    );
    expect(result.mode).toBe('none');
  });
});
