import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertMediaDataUrlWithinLimit: vi.fn(),
  consumeMediaDataUrlBudget: vi.fn(),
  readFileToDataUrl: vi.fn(),
}));

vi.mock('../../src/services/fileService', () => ({
  assertMediaDataUrlSize: vi.fn(),
  assertMediaDataUrlWithinLimit: mocks.assertMediaDataUrlWithinLimit,
  assertMediaDataUrlWithinLimitAsync: async (
    dataUrl: string,
    kind: string,
    label?: string,
  ) => {
    mocks.assertMediaDataUrlWithinLimit(dataUrl, kind, label);
    return 3;
  },
  consumeMediaDataUrlBudgetBytes: mocks.consumeMediaDataUrlBudget,
  consumeMediaDataUrlBudget: mocks.consumeMediaDataUrlBudget,
  isMediaDataUrl: (value: string) => /^data:/i.test(value),
  readFileToDataUrl: mocks.readFileToDataUrl,
}));

import { resolveMediaReferenceUrl } from '../../src/services/uploadService';

describe('resolveMediaReferenceUrl — 本地媒体参考统一分发', () => {
  beforeEach(() => {
    mocks.assertMediaDataUrlWithinLimit.mockReset();
    mocks.consumeMediaDataUrlBudget.mockReset();
    mocks.readFileToDataUrl.mockReset();
  });

  it('公网 URL 原样返回，dataUrl 模式的 data URL 只校验不重编码', async () => {
    await expect(resolveMediaReferenceUrl('https://cdn.example/a.mp4', { kind: 'video' }))
      .resolves.toBe('https://cdn.example/a.mp4');
    await expect(resolveMediaReferenceUrl('data:audio/mp3;base64,AAAA', {
      kind: 'audio',
      mode: 'dataUrl',
    }))
      .resolves.toBe('data:audio/mp3;base64,AAAA');
    expect(mocks.readFileToDataUrl).not.toHaveBeenCalled();
    expect(mocks.assertMediaDataUrlWithinLimit).toHaveBeenCalledWith(
      'data:audio/mp3;base64,AAAA',
      'audio',
      '音频参考',
    );
    expect(mocks.consumeMediaDataUrlBudget).toHaveBeenCalledWith(
      undefined,
      3,
    );
  });

  it('dataUrl 模式：本地文件转 base64 data URL', async () => {
    mocks.readFileToDataUrl.mockResolvedValue('data:video/mp4;base64,VIDEO');
    await expect(resolveMediaReferenceUrl('asset://localhost/v.mp4', { mode: 'dataUrl', kind: 'video' }))
      .resolves.toBe('data:video/mp4;base64,VIDEO');
    expect(mocks.readFileToDataUrl).toHaveBeenCalledWith(
      'asset://localhost/v.mp4',
      {
        kind: 'video',
        label: '视频参考',
        dataUrlBudget: undefined,
        signal: undefined,
      },
    );
  });

  it('dataUrl 模式：本地文件读取失败时抛出可读错误', async () => {
    mocks.readFileToDataUrl.mockResolvedValue(null);
    await expect(resolveMediaReferenceUrl('asset://localhost/v.mp4', { mode: 'dataUrl', kind: 'video' }))
      .rejects.toThrow('无法读取本地视频参考');
  });

  it('data URL 在传给 Provider 前执行解码字节预算', async () => {
    mocks.assertMediaDataUrlWithinLimit.mockImplementationOnce(() => {
      throw new Error('视频参考超过内存转换上限');
    });

    await expect(resolveMediaReferenceUrl('data:video/mp4;base64,AAAA', {
      kind: 'video',
      mode: 'dataUrl',
    }))
      .rejects.toThrow('视频参考超过内存转换上限');
  });
});
