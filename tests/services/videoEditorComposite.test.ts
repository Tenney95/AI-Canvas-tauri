/**
 * videoEditorComposite — 回归测试：needsCompositing。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Input } from 'mediabunny';

const audioMocks = vi.hoisted(() => ({
  canEncodeAudio: vi.fn(), packetAdd: vi.fn(), videoPacketAdd: vi.fn(), started: false, events: [] as string[],
}));
vi.mock('mediabunny', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mediabunny')>();
  return {
    ...actual,
    canEncodeAudio: audioMocks.canEncodeAudio,
    Output: class {
      format: InstanceType<typeof actual.Mp4OutputFormat>;
      target: InstanceType<typeof actual.BufferTarget>;
      constructor(options: { format: InstanceType<typeof actual.Mp4OutputFormat>; target: InstanceType<typeof actual.BufferTarget> }) {
        this.format = options.format; this.target = options.target;
      }
      addVideoTrack() {}
      addAudioTrack() { audioMocks.events.push('audio.track'); }
      async start() { audioMocks.started = true; audioMocks.events.push('output.start'); }
      async finalize() { this.target.buffer = new Uint8Array([1, 2, 3]).buffer; }
      async cancel() {}
    },
    CanvasSource: class {
      async add() {
        if (!audioMocks.started) throw new Error('Output was not started');
        audioMocks.events.push('video.add');
      }
      close() {}
    },
    EncodedAudioPacketSource: class {
      async add(...args: unknown[]) { audioMocks.packetAdd(...args); }
      close() {}
    },
    EncodedVideoPacketSource: class {
      async add(...args: unknown[]) { audioMocks.videoPacketAdd(...args); }
      close() {}
    },
    EncodedPacketSink: class {
      track: { packetTimes?: number[]; keyTime?: number };
      constructor(track: { packetTimes?: number[]; keyTime?: number }) { this.track = track; }
      async getPacket() {
        const timestamp = this.track.packetTimes?.[0];
        return timestamp === undefined ? null : { timestamp };
      }
      async getKeyPacket() { return { timestamp: this.track.keyTime ?? 0 }; }
      async getFirstKeyPacket() { return { timestamp: this.track.keyTime ?? 0 }; }
      async *packets() {
        for (const timestamp of this.track.packetTimes ?? [0]) {
          yield { timestamp, duration: 0.25, clone: (options: { timestamp: number }) => ({ timestamp: options.timestamp }) };
        }
      }
    },
  };
});

beforeEach(() => {
  audioMocks.canEncodeAudio.mockReset().mockResolvedValue(false);
  audioMocks.packetAdd.mockClear();
  audioMocks.videoPacketAdd.mockClear();
  audioMocks.started = false;
  audioMocks.events = [];
});

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
import { exportComposite, exportLosslessConcat, exportLosslessTrim, resolveCompositeAudioMode } from '../../src/services/videoEditorMediaService';
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

  it.each([{ muted: true }, { volume: 0 }, { volume: 0.5 }, { volume: 2 }])(
    'composites visible video-track audio changes: %j', (settings) => {
      expect(needsCompositing([{ ...videoTrack([clip({ id: 'a' })]), ...settings }])).toBe(true);
    },
  );

  it.each([
    { volume: 0 }, { volume: 0.5 }, { volume: 2 },
    { volumePoints: [{ t: 0, gain: 0 }, { t: 1, gain: 1 }] },
  ])('composites clip gains and volume envelopes without a visual edit: %j', (settings) => {
    expect(needsCompositing([videoTrack([clip({ id: 'a', ...settings })])])).toBe(true);
  });

  it('keeps default audio settings and irrelevant edits on the lossless path', () => {
    const main = { ...videoTrack([clip({ id: 'a', volume: 1, volumePoints: [] })]), muted: false, volume: 1 };
    expect(needsCompositing([main])).toBe(false);
    expect(needsCompositing([{ ...videoTrack([]), muted: true, volume: 0 }])).toBe(false);
    expect(needsCompositing([
      main,
      { ...videoTrack([clip({ id: 'hidden', volume: 0.5 })]), id: 'hidden', hidden: true, muted: true, volume: 0 },
      { id: 'muted', kind: 'audio', name: '静音配音', muted: true, volume: 0.5,
        clips: [clip({ id: 'voice', volume: 0, volumePoints: [{ t: 0, gain: 0 }] })] },
    ])).toBe(false);
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

function audioInput(options: {
  codec?: string | null; sampleRate?: number; channels?: number; description?: Uint8Array;
  decodable?: boolean; silent?: boolean; unknownConfig?: boolean; packetTimes?: number[];
} = {}): Input {
  const codec = options.codec === undefined ? 'aac' : options.codec;
  const track = {
    packetTimes: options.packetTimes,
    getCodec: async () => codec,
    getDecoderConfig: async () => options.unknownConfig ? null : ({
      codec, sampleRate: options.sampleRate ?? 48_000, numberOfChannels: options.channels ?? 2,
      description: options.description ?? new Uint8Array([18, 16]),
    }),
    canDecode: async () => options.decodable ?? true,
  };
  return { getPrimaryAudioTrack: async () => options.silent ? null : track } as unknown as Input;
}

describe('resolveCompositeAudioMode', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('probes AAC using the actual mix parameters before selecting encoding', async () => {
    audioMocks.canEncodeAudio.mockResolvedValue(true);
    const result = await resolveCompositeAudioMode([videoTrack([clip({ id: 'a' })])], () => audioInput());
    expect(result.mode).toBe('encode');
    expect(audioMocks.canEncodeAudio).toHaveBeenCalledWith('aac', {
      sampleRate: 48_000, numberOfChannels: 2, bitrate: expect.anything(),
    });
  });

  it('copies compatible audio when AudioEncoder exists but AAC is unsupported', async () => {
    vi.stubGlobal('AudioEncoder', class {});
    expect((await resolveCompositeAudioMode([videoTrack([
      clip({ id: 'a', sourceOut: 4 }), clip({ id: 'b', timelineStart: 4, sourceOut: 4 }),
    ])], () => audioInput())).mode).toBe('copy');
  });

  it('copies compatible audio after an AAC capability probe fails', async () => {
    audioMocks.canEncodeAudio.mockRejectedValue(new Error('unsupported config'));
    expect((await resolveCompositeAudioMode([videoTrack([clip({ id: 'a' })])], () => audioInput())).mode).toBe('copy');
  });

  it('uses PCM for overlap or volume edits when AAC is unavailable', async () => {
    const overlap = await resolveCompositeAudioMode([videoTrack([
      clip({ id: 'a', sourceOut: 4 }), clip({ id: 'b', timelineStart: 2, sourceOut: 4 }),
    ])], () => audioInput());
    expect(overlap.mode).toBe('pcm');
    expect(overlap.reason).toContain('重叠');
    for (const edited of [clip({ id: 'a', volume: 0.5 }), clip({ id: 'a', volumePoints: [{ t: 0, gain: 0 }] })]) {
      expect((await resolveCompositeAudioMode([videoTrack([edited])], () => audioInput())).mode).toBe('pcm');
    }
    expect((await resolveCompositeAudioMode([
      { ...videoTrack([clip({ id: 'a' })]), volume: 0.5 },
    ], () => audioInput())).mode).toBe('pcm');
  });

  it.each([
    { sampleRate: 44_100 },
    { channels: 1 },
    { description: new Uint8Array([19, 16]) },
    { unknownConfig: true },
  ])('does not copy incompatible decoder configurations: %j', async (options) => {
    const inputs = [audioInput(), audioInput(options)];
    const tracks = [videoTrack([clip({ id: 'a', sourceOut: 4 }), clip({ id: 'b', timelineStart: 4, sourceOut: 4 })])];
    expect((await resolveCompositeAudioMode(tracks, (value) => inputs[value.id === 'a' ? 0 : 1])).mode).toBe('pcm');
  });

  it('checks source audio against MP4 support before copying packets', async () => {
    // MP4 支持 pcm-s16，但不支持这个源 PCM 编码；必须解码后再输出。
    const result = await resolveCompositeAudioMode([videoTrack([clip({ id: 'a' })])], () => audioInput({ codec: 'pcm-u8' }));
    expect(result.mode).toBe('pcm');
    expect(result.reason).toContain('MP4');
  });

  it('rejects undecodable audio that needs mixing instead of silently omitting it', async () => {
    await expect(resolveCompositeAudioMode([videoTrack([clip({ id: 'a', volume: 0.5 })])],
      () => audioInput({ decodable: false }))).rejects.toThrow('无法保留');
    // 直接复制无需解码；这类素材仍可保留原音轨。
    expect((await resolveCompositeAudioMode([videoTrack([clip({ id: 'a' })])],
      () => audioInput({ decodable: false }))).mode).toBe('copy');
  });

  it('ignores silent video when checking audio overlap and finds a later audio track', async () => {
    const result = await resolveCompositeAudioMode([videoTrack([
      clip({ id: 'silent', sourceOut: 8 }), clip({ id: 'audible', timelineStart: 4, sourceOut: 4 }),
    ])], (value) => audioInput({ silent: value.id === 'silent' }));
    expect(result.mode).toBe('copy');
  });

  it('only reports no audio for silent, empty, muted, image or text content', async () => {
    audioMocks.canEncodeAudio.mockResolvedValue(true);
    expect((await resolveCompositeAudioMode([videoTrack([])], () => audioInput())).mode).toBe('none');
    expect((await resolveCompositeAudioMode([
      { ...videoTrack([clip({ id: 'a' })]), muted: true },
    ], () => audioInput())).mode).toBe('none');
    expect((await resolveCompositeAudioMode([videoTrack([clip({ id: 'silent' })])],
      () => audioInput({ silent: true }))).mode).toBe('none');
    expect((await resolveCompositeAudioMode([videoTrack([
      clip({ id: 'image', kind: 'image' }), clip({ id: 'text', kind: 'text' }),
    ])], () => undefined)).mode).toBe('none');
    expect(audioMocks.canEncodeAudio).not.toHaveBeenCalled();
  });
});

describe('composite packet-copy output lifecycle', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('starts the output and copies a later audio track after a silent first video', async () => {
    const surface = {
      width: 0, height: 0,
      getContext: () => ({ clearRect: vi.fn(), fillRect: vi.fn() }),
    };
    vi.stubGlobal('document', { createElement: () => surface });
    const silent = audioInput({ silent: true });
    const audible = audioInput();
    const modes: string[] = [];
    const bytes = await exportComposite({
      tracks: [videoTrack([
        clip({ id: 'silent', sourceOut: 1 }), clip({ id: 'audible', timelineStart: 1, sourceOut: 1 }),
      ])],
      duration: 2, frameRate: 1, canvas: { width: 2, height: 2 },
      resolveVideo: () => undefined,
      resolveAudio: (value) => value.id === 'silent' ? silent : audible,
      onAudioMode: (mode) => modes.push(mode),
    });
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(modes).toEqual(['copy']);
    expect(audioMocks.events).toEqual(['audio.track', 'output.start', 'video.add', 'video.add']);
    expect(audioMocks.packetAdd).toHaveBeenCalledOnce();
    expect(audioMocks.packetAdd.mock.calls[0][0]).toMatchObject({ timestamp: 1 });
  });
});

function losslessInput(options: Parameters<typeof audioInput>[0] & { videoKeyTime?: number; videoPacketTimes?: number[] } = {}): Input {
  const video = {
    displayWidth: 640, displayHeight: 360, rotation: 0,
    keyTime: options.videoKeyTime ?? 0,
    packetTimes: options.videoPacketTimes ?? [options.videoKeyTime ?? 0],
    getCodec: async () => 'avc',
    getDecoderConfig: async () => ({ codec: 'avc1.42001e', codedWidth: 640, codedHeight: 360 }),
  };
  return { ...audioInput(options), getPrimaryVideoTrack: async () => video } as unknown as Input;
}

describe('lossless audio preservation', () => {
  it.each([
    { audible: [false, true], timestamps: [1] },
    { audible: [true, false], timestamps: [0] },
    { audible: [true, false, true], timestamps: [0, 2] },
    { audible: [false, true, false], timestamps: [1] },
  ])('preserves compatible audio around silent segments: %j', async ({ audible, timestamps }) => {
    const result = await exportLosslessConcat({ segments: audible.map((hasAudio, index) => ({
      input: losslessInput({ silent: !hasAudio }), start: 0, end: 1, label: `clip-${index}`,
    })) });
    expect(result.audioKept).toBe(true);
    expect(result.audioDropReason).toBeUndefined();
    expect(audioMocks.videoPacketAdd).toHaveBeenCalledTimes(audible.length);
    expect(audioMocks.packetAdd.mock.calls.map(([packet]) => packet.timestamp)).toEqual(timestamps);
    expect(audioMocks.events).toEqual(['audio.track', 'output.start']);
  });

  it.each([1, 2, 3])('exports a genuinely silent timeline with %i segments', async (count) => {
    const result = await exportLosslessConcat({ segments: Array.from({ length: count }, (_, index) => ({
      input: losslessInput({ silent: true }), start: 0, end: 1, label: `silent-${index}`,
    })) });
    expect(result.audioKept).toBe(false);
    expect(result.audioDropReason).toBe('素材没有音轨');
    expect(audioMocks.packetAdd).not.toHaveBeenCalled();
    expect(audioMocks.videoPacketAdd).toHaveBeenCalledTimes(count);
    expect(audioMocks.events).toEqual(['output.start']);
  });

  it.each([
    { sampleRate: 44_100 },
    { channels: 1 },
    { description: new Uint8Array([19, 16]) },
    { unknownConfig: true },
    { codec: 'pcm-u8' },
    { codec: null },
  ])('rejects incompatible real audio before starting output: %j', async (settings) => {
    await expect(exportLosslessConcat({ segments: [
      { input: losslessInput(), start: 0, end: 1, label: 'aac' },
      { input: losslessInput(settings), start: 0, end: 1, label: 'incompatible' },
    ] })).rejects.toThrow();
    expect(audioMocks.events).not.toContain('output.start');
    expect(audioMocks.packetAdd).not.toHaveBeenCalled();
    expect(audioMocks.videoPacketAdd).not.toHaveBeenCalled();
  });

  it('compares decoder-description contents rather than backing-buffer offsets', async () => {
    const description = new Uint8Array([99, 18, 16, 99]).subarray(1, 3);
    const result = await exportLosslessConcat({ segments: [
      { input: losslessInput(), start: 0, end: 1, label: 'original' },
      { input: losslessInput({ description }), start: 0, end: 1, label: 'view' },
    ] });
    expect(result.audioKept).toBe(true);
    expect(audioMocks.packetAdd).toHaveBeenCalledTimes(2);
  });

  it.each(['pcm-u8', null])('rejects a single unsupported or unknown audio codec: %s', async (codec) => {
    const input = losslessInput({ codec });
    await expect(exportLosslessTrim({ input, start: 0, end: 1 })).rejects.toThrow();
    await expect(exportLosslessConcat({ segments: [{ input, start: 0, end: 1, label: 'single' }] })).rejects.toThrow();
    expect(audioMocks.events).not.toContain('output.start');
    expect(audioMocks.packetAdd).not.toHaveBeenCalled();
    expect(audioMocks.videoPacketAdd).not.toHaveBeenCalled();
  });

  it('does not shift a later segment pre-roll packet into the preceding silent interval', async () => {
    const result = await exportLosslessConcat({ segments: [
      { input: losslessInput({ silent: true }), start: 0, end: 1, label: 'silent' },
      { input: losslessInput({ videoKeyTime: 2, packetTimes: [1.875, 2.125, 2.375] }), start: 2, end: 3, label: 'audible' },
    ] });
    expect(result.audioKept).toBe(true);
    expect(audioMocks.packetAdd.mock.calls.map(([packet]) => packet.timestamp)).toEqual([1.125, 1.375]);
    expect(audioMocks.videoPacketAdd.mock.calls.map(([packet]) => packet.timestamp)).toEqual([0, 1]);
  });

  it('still stops packet copying when cancellation arrives after the first video packet', async () => {
    const controller = new AbortController();
    await expect(exportLosslessConcat({
      segments: [0, 1].map((index) => ({ input: losslessInput(), start: 0, end: 1, label: `clip-${index}` })),
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })).rejects.toThrow('已取消');
    expect(audioMocks.videoPacketAdd).toHaveBeenCalledOnce();
    expect(audioMocks.packetAdd).not.toHaveBeenCalled();
  });
});

describe('lossless trim boundaries', () => {
  it('copies an uninterrupted source range just once after splitting between keyframes', async () => {
    const input = losslessInput({ packetTimes: [0, 0.25, 0.5, 0.75], videoPacketTimes: [0, 0.25, 0.5, 0.75] });
    const segments = [
      { input, start: 0, end: 0.5, label: 'before split' },
      { input, start: 0.5, end: 0.75, label: 'after split' },
    ];
    const result = await exportLosslessConcat({ segments });

    expect(result.actualStart).toBe(0);
    expect(segments[0].end).toBe(0.5);
    expect(audioMocks.videoPacketAdd.mock.calls.map(([packet]) => packet.timestamp)).toEqual([0, 0.25, 0.5]);
    expect(audioMocks.packetAdd.mock.calls.map(([packet]) => packet.timestamp)).toEqual([0, 0.25, 0.5]);
  });

  it.each([false, true])('rejects a non-keyframe in-point before writing packets (multiple pieces: %s)', async (multiple) => {
    const input = losslessInput();
    const nonKeyframeSegment = { input, start: 0.5, end: 1, label: 'non-keyframe entry' };
    const segments = multiple
      ? [{ input, start: 0, end: 0.25, label: 'earlier piece' }, nonKeyframeSegment]
      : [nonKeyframeSegment];

    await expect(exportLosslessConcat({ segments })).rejects.toThrow('入点未对齐关键帧');
    expect(audioMocks.events).not.toContain('output.start');
    expect(audioMocks.videoPacketAdd).not.toHaveBeenCalled();
    expect(audioMocks.packetAdd).not.toHaveBeenCalled();
  });
});
