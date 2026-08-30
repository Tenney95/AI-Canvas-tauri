import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(`../../src/services/ai/${relativePath}`, import.meta.url), 'utf8');
}

describe('媒体引用内存守卫接线', () => {
  it('图片上传透传调用方取消信号', () => {
    expect(source('generateImage.ts')).toContain(
      'resolveImageUrlArray(allImageUrls, provider, signal)',
    );
  });

  it('通用视频的音视频引用共享一个请求级 Data URL 总预算', () => {
    const videoSource = source('generateVideo.ts');
    expect(videoSource).toContain("createMediaDataUrlBudget('本次视频模型参考媒体')");
    expect(videoSource).toContain("originalReferences, 'video', dataUrlBudget, signal");
    expect(videoSource).toContain("originalReferences, 'audio', dataUrlBudget, signal");
  });

  it('通用音频引用按顺序转换并检查取消信号', () => {
    const audioSource = source('generateAudio.ts');
    expect(audioSource).toContain('for (const reference of audioReferences)');
    expect(audioSource).toContain("mode: 'dataUrl', kind: 'audio', signal, dataUrlBudget: budget");
    expect(audioSource).not.toMatch(
      /Promise\.all\(references\.filter\(\(reference\) => reference\.kind === 'audio'\)/,
    );
  });
});
