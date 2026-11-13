import { describe, expect, it } from 'vitest';
import { getHttpResponseError, HttpResponseError } from '../../src/services/ai/httpUtils';
import { ModelProtocolHttpError } from '../../src/services/ai/modelProtocolHttp';
import { PollTaskFailedError, PollTimeoutError } from '../../src/services/pollTask';
import { redactVolcengineError, redactVolcengineErrorText } from '../../src/services/ai/providers/volcengineError';

const signedUrl = 'https://private-bucket.tos-cn-beijing.ivolces.com/ai-canvas/ark-reference/ref.png'
  + '?X-Tos-Credential=fixtureAK%2F20261113%2Fcn-beijing%2Ftos%2Frequest&X-Tos-Signature=fixtureSignature';

describe('方舟 TOS 错误脱敏', () => {
  it.each([
    signedUrl,
    signedUrl.replaceAll('/', '\\/'),
    encodeURIComponent(signedUrl),
    encodeURIComponent(encodeURIComponent(signedUrl)),
    encodeURIComponent(signedUrl).replace(/%[\da-f]{2}/gi, (escape) => escape.toLowerCase()),
    signedUrl.replace('.ivolces.com', '.volces.com'),
    `${encodeURIComponent(signedUrl)}%E4`,
  ])('删除完整原始或编码签名链接，保留周围错误诊断', (url) => {
    expect(redactVolcengineErrorText(`Timeout while downloading url=${url} Request id: request-1`))
      .toBe('Timeout while downloading url=[REDACTED] Request id: request-1');
  });

  it('保留 HTTP 状态、明确拒绝和重试时长，同时继续隐藏 Ark Key', () => {
    const apiKey = 'ark secret+/~';
    const error = new ModelProtocolHttpError(429,
      `Denied ${signedUrl} ${encodeURIComponent(signedUrl)} ${apiKey} ${encodeURIComponent(apiKey)}`, 1500, false);
    const safe = redactVolcengineError(error, apiKey);
    expect(safe).toBeInstanceOf(ModelProtocolHttpError);
    expect(safe).toMatchObject({ status: 429, definitiveFailure: false, retryAfterMs: 1500,
      message: 'Denied [REDACTED] [REDACTED] [REDACTED] [REDACTED]',
    });
    expect((safe as Error).stack).not.toContain('fixtureSignature');
  });

  it('包装错误的 HTTP cause 不保留签名或改变拒绝分类', () => {
    const cause = new HttpResponseError(400, `Invalid image ${signedUrl}`, true);
    const error = Object.freeze(new Error('图片生成失败', { cause }));
    const safe = redactVolcengineError(error);
    expect(getHttpResponseError(safe)).toMatchObject({ status: 400, definitiveFailure: true, message: '图片生成失败' });
    expect((safe as Error).cause).toBeUndefined();
    expect(error.cause).toBe(cause);
  });

  it.each([PollTaskFailedError, PollTimeoutError])('保留轮询错误类型', (ErrorType) => {
    const safe = redactVolcengineError(new ErrorType(`任务失败 ${signedUrl}`));
    expect(safe).toBeInstanceOf(ErrorType);
    expect((safe as Error).message).toBe('任务失败 [REDACTED]');
  });

  it('取消和无敏感内容的错误保持原有身份', () => {
    const aborted = new DOMException('Request aborted', 'AbortError');
    const failure = new HttpResponseError(503, 'Upstream unavailable');
    expect(redactVolcengineError(aborted)).toBe(aborted);
    expect(redactVolcengineError(failure)).toBe(failure);
    expect(redactVolcengineError(`下载失败 ${signedUrl}`)).toBe('下载失败 [REDACTED]');
  });

  it('普通 URL、未签名的 TOS URL和仿冒域名保留诊断内容', () => {
    const message = 'https://example.com/ref.png?X-Tos-Signature=public '
      + 'https://private-bucket.tos-cn-beijing.ivolces.com/ref.png '
      + `${signedUrl.replace('.ivolces.com', '.ivolces.com.example.com')}`;
    expect(redactVolcengineErrorText(message)).toBe(message);
  });
});
