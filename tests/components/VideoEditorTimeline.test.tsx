import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import VideoEditorTimeline from '../../src/components/videoEditor/VideoEditorTimeline';
import type { VideoEditorClip, VideoEditorTrack } from '../../src/types/videoEditor';

function clip(overrides: Partial<VideoEditorClip>): VideoEditorClip {
  return {
    id: 'clip-a',
    kind: 'video',
    sourceUrl: 'https://example.test/a.mp4',
    fileName: 'a.mp4',
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 4,
    ...overrides,
  };
}

function render(tracks: VideoEditorTrack[]): string {
  return renderToStaticMarkup(
    <VideoEditorTimeline
      tracks={tracks}
      duration={8}
      playhead={0}
      selectedClipIds={[]}
      getSource={() => undefined}
      snapEnabled
      onToggleSnap={vi.fn()}
      onPlayheadChange={vi.fn()}
      onSelectClips={vi.fn()}
      onTrimClip={vi.fn()}
      onMoveClip={vi.fn()}
      onMoveClipToTrack={vi.fn()}
      onMoveClipInOverlay={vi.fn()}
      onCreateTrackAndMove={vi.fn()}
      onSplit={vi.fn()}
      onDeleteSelected={vi.fn()}
      onDuplicateClip={vi.fn()}
      onEditTransition={vi.fn()}
      onTracksChange={vi.fn()}
      onAddTrack={vi.fn()}
      onMoveTrack={vi.fn()}
      onBeginInteraction={vi.fn()}
      onEndInteraction={vi.fn()}
      canSplit
      canUndo={false}
      canRedo={false}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
    />,
  );
}

const mainTrack = (clips: VideoEditorClip[]): VideoEditorTrack => ({
  id: 'main',
  kind: 'video',
  name: '视频轨 1',
  clips,
});

describe('VideoEditorTimeline transitions', () => {
  it('uses the shared UI Kit ruler and thumbnail track', () => {
    const html = render([mainTrack([clip({})])]);
    expect(html).toContain('ui-timeline__ruler');
    expect(html).toContain('ui-timeline__thumbnails');
    expect(html).not.toContain('video-editor-clip-thumbs');
  });
  it('keeps editor operations accessible when rendered as icon-only tools', () => {
    const html = render([mainTrack([clip({})])]);
    const head = html.slice(html.indexOf('video-editor-timeline-head'), html.indexOf('video-editor-timeline-body'));
    for (const label of ['撤销', '重做', '分割', '复制片段', '删除选中片段', '吸附', '叠加轨', '音频轨', '缩小', '放大', '适应窗口']) {
      expect(head).toContain(`aria-label="${label}"`);
    }
    expect(head).toContain('ui-icon-btn--ghost');
    expect(head).toContain('aria-keyshortcuts="S"');
    expect(head).toContain('ui-timeline__split-icon');
    expect(head).not.toContain('<kbd');
    expect(head).not.toContain('>分割<');
    expect(html).toContain('ui-timeline__tick-label">00:00</em>');
  });
  it('marks a clip that carries a transition and labels its seam', () => {
    const html = render([mainTrack([
      clip({}),
      clip({
        id: 'clip-b',
        fileName: 'b.mp4',
        timelineStart: 4,
        transitionIn: { kind: 'dissolve', duration: 0.8 },
      }),
    ])]);

    expect(html).toContain('video-editor-clip-transition dissolve');
    expect(html).toContain('video-editor-seam has-transition');
    expect(html).toContain('交叠淡入 0.8s');
  });

  it('offers an add-transition seam on every main-track clip after the first', () => {
    const html = render([mainTrack([
      clip({}),
      clip({ id: 'clip-b', fileName: 'b.mp4', timelineStart: 4 }),
    ])]);

    // 首段之前没有可衔接的画面，不应该出现接缝
    expect(html.match(/video-editor-seam/g)).toHaveLength(1);
    expect(html).toContain('在这里添加转场：b.mp4');
    expect(html).not.toContain('video-editor-clip-transition');
  });

  it('keeps seams off overlay and locked tracks, where clips are not magnetically adjacent', () => {
    const overlayHtml = render([
      mainTrack([clip({})]),
      {
        id: 'overlay',
        kind: 'video',
        name: '贴图',
        overlay: true,
        clips: [
          clip({ id: 'ov-a', timelineStart: 0 }),
          clip({ id: 'ov-b', timelineStart: 2 }),
        ],
      },
    ]);
    expect(overlayHtml).not.toContain('video-editor-seam');

    const lockedHtml = render([{
      ...mainTrack([clip({}), clip({ id: 'clip-b', timelineStart: 4 })]),
      locked: true,
    }]);
    expect(lockedHtml).not.toContain('video-editor-seam');
  });
});
