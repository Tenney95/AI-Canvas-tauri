import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getNodeMetaMap, numberMediaReferenceLabels } from '../../src/components/nodes/shared/mentionEditorDom';
import { renderPromptWithChips } from '../../src/components/nodes/shared/PromptChipViewer';

describe('mention editor media reference indices', () => {
  it('numbers references by first appearance and reuses the index for duplicates', () => {
    expect(numberMediaReferenceLabels([
      { kind: 'image', key: 'node:image-a' },
      undefined,
      { kind: 'image', key: 'asset:image-b' },
      { kind: 'image', key: 'node:image-a' },
    ])).toEqual(['(图1)', undefined, '(图2)', '(图1)']);
  });

  it('混合引用按图片、视频和音频分别编号，重复引用不占新序号', () => {
    expect(numberMediaReferenceLabels([
      { kind: 'audio', key: 'node:a' },
      { kind: 'video', key: 'node:v' },
      { kind: 'image', key: 'node:i' },
      { kind: 'audio', key: 'node:b' },
      { kind: 'audio', key: 'node:a' },
      undefined,
      { kind: 'video', key: 'node:w' },
      { kind: 'image', key: 'node:j' },
    ])).toEqual(['(音频1)', '(视频1)', '(图1)', '(音频2)', '(音频1)', undefined, '(视频2)', '(图2)']);
  });

  it('视频封面不算图片参考，尚无输出的媒体不显示序号', () => {
    const meta = getNodeMetaMap([
      { id: 'video', data: { type: 'ai-video', videoUrl: 'https://media.test/video.mp4', thumbnailUrl: 'https://media.test/poster.png' } },
      { id: 'audio', data: { type: 'ai-audio', audioUrl: 'https://media.test/audio.wav' } },
      { id: 'empty', data: { type: 'ai-video', videoUrl: ' ', thumbnailUrl: 'https://media.test/poster.png' } },
    ] as never);
    expect(meta.get('video')?.mediaReference).toEqual({ kind: 'video', key: 'node:video' });
    expect(meta.get('audio')?.mediaReference).toEqual({ kind: 'audio', key: 'node:audio' });
    expect(meta.get('empty')?.mediaReference).toBeUndefined();
  });

  it('生成信息的胶囊与编辑器共用编号，文本引用不影响媒体顺序', () => {
    const nodes = [
      { id: 'text', data: { type: 'ai-text', output: '镜头说明' } },
      { id: 'a', data: { type: 'ai-audio', audioUrl: 'https://media.test/a.wav' } },
      { id: 'b', data: { type: 'ai-audio', audioUrl: 'https://media.test/b.wav' } },
      { id: 'v', data: { type: 'ai-video', videoUrl: 'https://media.test/v.mp4' } },
      { id: 'w', data: { type: 'ai-video', videoUrl: 'https://media.test/w.mp4' } },
      { id: 'i', data: { type: 'ai-image', imageUrl: 'https://media.test/i.png' } },
    ];
    const html = renderToStaticMarkup(renderPromptWithChips('@{text:说明} @{a:音频A} @{v:视频V} @{i:图I} @{b:音频B} @{w:视频W} @{a:音频A}', { nodes }));
    const labels = Array.from(html.matchAll(/<span class="[^"]*prompt-chip-media-index[^"]*">([^<]+)<\/span>/g), (match) => match[1]);
    expect(labels).toEqual(['(音频1)', '(视频1)', '(图1)', '(音频2)', '(视频2)', '(音频1)']);
  });
});
