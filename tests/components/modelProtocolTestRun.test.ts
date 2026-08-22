import { describe, expect, it } from 'vitest';
import { describeProtocolTestRunBlocker } from '../../src/components/settings/modelProtocolTestRun';

describe('模型协议试跑前置条件', () => {
  it('凭据与地址齐全的声明式协议可以试跑', () => {
    expect(describeProtocolTestRunBlocker('custom', 'sk-test', 'https://gw.example/v1')).toBeNull();
    expect(describeProtocolTestRunBlocker('openai-chat', 'sk-test', 'https://gw.example/v1')).toBeNull();
  });

  it('自动兼容不走声明式协议，没有东西可跑', () => {
    expect(describeProtocolTestRunBlocker('legacy', 'sk-test', 'https://gw.example/v1'))
      .toBe('legacy-preset');
  });

  it('缺地址或缺密钥时先报地址，空白字符不算填写', () => {
    expect(describeProtocolTestRunBlocker('custom', 'sk-test', '   ')).toBe('missing-base-url');
    expect(describeProtocolTestRunBlocker('custom', '  ', 'https://gw.example/v1'))
      .toBe('missing-api-key');
  });
});
