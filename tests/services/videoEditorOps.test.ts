import { describe, expect, it } from 'vitest';

import {
  clampZoom,
  clipEdges,
  collectFrameSourceClips,
  dropIndexAt,
  duplicateClip,
  fitZoom,
  isClipLocked,
  isTrackLocked,
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  moveClipTo,
  duplicateClipInTracks,
  removeClips,
  removeClipsFromTracks,
  rectsIntersect,
  snapTime,
  updateClipInTracks,
} from '../../src/components/videoEditor/timelineOps';
import {
  getClipDuration,
  relayoutSequential,
  type VideoEditorClip,
  type VideoEditorTrack,
} from '../../src/types/videoEditor';

function clip(id: string, duration: number): VideoEditorClip {
  return {
    id,
    kind: 'video',
    fileName: `${id}.mp4`,
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: duration,
  };
}

const threeClips = () => relayoutSequential([clip('a', 4), clip('b', 6), clip('c', 2)]);

function multitrack(): VideoEditorTrack[] {
  return [
    { id: 'main', kind: 'video', name: '主轨', clips: relayoutSequential([clip('a', 4), clip('b', 6)]) },
    {
      id: 'overlay',
      kind: 'video',
      name: '叠加轨',
      overlay: true,
      clips: [{ ...clip('overlay-a', 3), timelineStart: 7 }],
    },
  ];
}

describe('track-aware clip operations', () => {
  it('collects only clips needed at the requested frame plus a contiguous dissolve underlay', () => {
    const first = { ...clip('first', 4), timelineStart: 0 };
    const second = {
      ...clip('second', 4),
      timelineStart: 4,
      transitionIn: { kind: 'dissolve' as const, duration: 1 },
    };
    const distant = { ...clip('distant', 3), timelineStart: 20 };
    const tracks: VideoEditorTrack[] = [
      { id: 'main', kind: 'video', name: '主轨', clips: [first, second, distant] },
      { id: 'hidden', kind: 'video', name: '隐藏轨', hidden: true, clips: [{ ...clip('hidden', 8) }] },
      { id: 'audio', kind: 'audio', name: '音轨', clips: [{ ...clip('audio', 8) }] },
    ];

    expect(collectFrameSourceClips(tracks, 4.25).map((entry) => entry.id))
      .toEqual(['first', 'second']);
    expect(collectFrameSourceClips(tracks, 10)).toEqual([]);
  });

  it('resolves locked state by either track id or clip id', () => {
    const tracks = multitrack().map((track) => (
      track.id === 'overlay' ? { ...track, locked: true } : track
    ));

    expect(isTrackLocked(tracks, 'overlay')).toBe(true);
    expect(isTrackLocked(tracks, 'main')).toBe(false);
    expect(isClipLocked(tracks, 'overlay-a')).toBe(true);
    expect(isClipLocked(tracks, 'a')).toBe(false);
    expect(isClipLocked(tracks, 'missing')).toBe(false);
  });

  it('trims only the owning overlay track without moving its timeline position', () => {
    const tracks = multitrack();
    const updated = updateClipInTracks(tracks, 'overlay-a', (entry) => ({
      ...entry,
      sourceIn: 1,
      sourceOut: 2.5,
    }));

    expect(updated[0]).toBe(tracks[0]);
    expect(updated[1].clips[0]).toMatchObject({
      id: 'overlay-a',
      timelineStart: 7,
      sourceIn: 1,
      sourceOut: 2.5,
    });
  });

  it('re-packs the main track when a trim changes a main clip duration', () => {
    const updated = updateClipInTracks(multitrack(), 'a', (entry) => ({
      ...entry,
      sourceOut: 2,
    }));

    expect(updated[0].clips.map((entry) => entry.timelineStart)).toEqual([0, 2]);
    expect(updated[1].clips[0].timelineStart).toBe(7);
  });

  it('removes selected clips across tracks while preserving overlay positions', () => {
    const updated = removeClipsFromTracks(multitrack(), ['b', 'overlay-a']);

    expect(updated[0].clips.map((entry) => entry.id)).toEqual(['a']);
    expect(updated[1].clips).toEqual([]);
  });

  it('refuses to remove the last clip in the whole project', () => {
    const tracks = multitrack();
    expect(removeClipsFromTracks(tracks, ['a', 'b', 'overlay-a'])).toBe(tracks);
  });

  it('duplicates only the owning overlay clip after its source time range', () => {
    const tracks = multitrack();
    const updated = duplicateClipInTracks(tracks, 'overlay-a');

    expect(updated[0]).toBe(tracks[0]);
    expect(updated[1].clips).toHaveLength(2);
    expect(updated[1].clips[1]).toMatchObject({ timelineStart: 10, sourceIn: 0, sourceOut: 3 });
    expect(updated[1].clips[1].id).not.toBe('overlay-a');
  });
});

describe('moveClipTo', () => {
  it('reorders and re-packs the timeline', () => {
    const moved = moveClipTo(threeClips(), 'c', 0);
    expect(moved.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
    expect(moved.map((entry) => entry.timelineStart)).toEqual([0, 2, 6]);
  });

  it('clamps an out-of-range target index', () => {
    expect(moveClipTo(threeClips(), 'a', 99).map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
    expect(moveClipTo(threeClips(), 'c', -5).map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op for an unknown clip or an unchanged position', () => {
    const clips = threeClips();
    expect(moveClipTo(clips, 'zzz', 0)).toBe(clips);
    expect(moveClipTo(clips, 'a', 0)).toBe(clips);
  });
});

describe('duplicateClip', () => {
  it('inserts the copy right after the source with a fresh id', () => {
    const duplicated = duplicateClip(threeClips(), 'a');
    expect(duplicated).toHaveLength(4);
    expect(duplicated[1].id).not.toBe('a');
    expect(duplicated[1].fileName).toBe('a.mp4');
    expect(duplicated.map((entry) => entry.timelineStart)).toEqual([0, 4, 8, 14]);
  });

  it('keeps the source trim on the copy', () => {
    const clips = relayoutSequential([{ ...clip('a', 10), sourceIn: 2, sourceOut: 5 }]);
    const [, copy] = duplicateClip(clips, 'a');
    expect(copy.sourceIn).toBe(2);
    expect(copy.sourceOut).toBe(5);
  });
});

describe('removeClips', () => {
  it('drops the given clips and closes the gap', () => {
    const kept = removeClips(threeClips(), ['b']);
    expect(kept.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(kept.map((entry) => entry.timelineStart)).toEqual([0, 4]);
  });

  it('removes several at once', () => {
    expect(removeClips(threeClips(), ['a', 'c']).map((entry) => entry.id)).toEqual(['b']);
  });

  it('refuses to empty the timeline', () => {
    const clips = threeClips();
    expect(removeClips(clips, ['a', 'b', 'c'])).toBe(clips);
  });
});

describe('clipEdges', () => {
  it('collects every boundary plus the origin, deduped and sorted', () => {
    expect(clipEdges(threeClips())).toEqual([0, 4, 10, 12]);
  });

  it('returns just the origin for an empty timeline', () => {
    expect(clipEdges([])).toEqual([0]);
  });
});

describe('snapTime', () => {
  it('snaps to the nearest candidate inside the pixel tolerance', () => {
    // 100px/s 下 6px 容差 = 0.06s
    expect(snapTime(4.03, [0, 4, 10], 100)).toBe(4);
  });

  it('leaves the time alone beyond the tolerance', () => {
    expect(snapTime(4.5, [0, 4, 10], 100)).toBe(4.5);
  });

  it('tightens in seconds as the zoom grows', () => {
    // 放大后同样的 0.2s 偏差不再吸附
    expect(snapTime(4.2, [4], 10)).toBe(4);
    expect(snapTime(4.2, [4], 200)).toBe(4.2);
  });

  it('is a no-op when the scale is degenerate', () => {
    expect(snapTime(3.3, [3], 0)).toBe(3.3);
  });
});

describe('clampZoom / fitZoom', () => {
  it('keeps zoom inside the allowed range', () => {
    expect(clampZoom(0.01)).toBe(MIN_PIXELS_PER_SECOND);
    expect(clampZoom(99999)).toBe(MAX_PIXELS_PER_SECOND);
    expect(clampZoom(50)).toBe(50);
  });

  it('fits the whole timeline into the available width', () => {
    expect(fitZoom(10, 500)).toBe(50);
    // 极长素材会撞上最小缩放
    expect(fitZoom(100000, 500)).toBe(MIN_PIXELS_PER_SECOND);
  });

  it('falls back to a usable default for a degenerate timeline', () => {
    expect(fitZoom(0, 500)).toBe(40);
    expect(fitZoom(10, 0)).toBe(40);
  });
});

describe('rectsIntersect', () => {
  it('selects overlapping and edge-touching timeline clips', () => {
    const selection = { left: 10, top: 10, right: 50, bottom: 50 };
    expect(rectsIntersect(selection, { left: 40, top: 40, right: 80, bottom: 80 })).toBe(true);
    expect(rectsIntersect(selection, { left: 50, top: 20, right: 70, bottom: 30 })).toBe(true);
  });

  it('ignores clips outside the marquee', () => {
    expect(rectsIntersect(
      { left: 10, top: 10, right: 50, bottom: 50 },
      { left: 51, top: 20, right: 70, bottom: 30 },
    )).toBe(false);
  });
});

describe('dropIndexAt', () => {
  it('resolves the insertion slot from the pointer time', () => {
    const clips = threeClips();
    // 拖动 c 时，其余为 a[0,4) b[4,10)，中点各是 2 与 7
    expect(dropIndexAt(clips, 1, 'c')).toBe(0);
    expect(dropIndexAt(clips, 3, 'c')).toBe(1);
    expect(dropIndexAt(clips, 8, 'c')).toBe(2);
  });

  it('never counts the dragged clip itself', () => {
    const clips = threeClips();
    expect(dropIndexAt(clips, 99, 'a')).toBe(2);
  });
});

describe('total duration invariants', () => {
  it('is preserved by reordering and by duplication accounting', () => {
    const clips = threeClips();
    const total = clips.reduce((sum, entry) => sum + getClipDuration(entry), 0);
    expect(moveClipTo(clips, 'c', 0).reduce((sum, e) => sum + getClipDuration(e), 0)).toBe(total);
    expect(duplicateClip(clips, 'a').reduce((sum, e) => sum + getClipDuration(e), 0)).toBe(total + 4);
  });
});
