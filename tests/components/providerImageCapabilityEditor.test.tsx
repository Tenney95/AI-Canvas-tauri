/**
 * providerImageCapabilityEditor — 回归测试：image capability editor。
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ImageCapabilityEditor from '../../src/components/settings/providerConnection/ImageCapabilityEditor';

describe('image capability editor', () => {
  it('shows both saved prompt budgets without changing the capability', () => {
    const capability = { promptMaxCharacters: 50_000, promptMaxNonAsciiCharacters: 21_000 };
    const html = renderToStaticMarkup(createElement(ImageCapabilityEditor, {
      model: { id: 'custom-image', name: 'Custom Image', category: 'image', provider: 'custom', imageCapability: capability },
      onChange: () => undefined, onApplyTemplate: () => undefined, onClose: () => undefined,
    }));
    expect(html).toMatch(/<input[^>]*aria-label="提示词最多字符"[^>]*value="50000"/);
    expect(html).toMatch(/<input[^>]*aria-label="非 ASCII 提示词预算"[^>]*value="21000"/);
    expect(html).toContain('ASCII/最多字符');
    expect(capability).toEqual({ promptMaxCharacters: 50_000, promptMaxNonAsciiCharacters: 21_000 });
  });

  it('keeps missing capabilities undeclared instead of selecting preset tiers', () => {
    const html = renderToStaticMarkup(createElement(ImageCapabilityEditor, {
      model: { id: 'custom-image', name: 'Custom Image', category: 'image', provider: 'custom' },
      onChange: () => undefined, onApplyTemplate: () => undefined, onClose: () => undefined,
    }));
    expect(html).toContain('图片参数能力');
    expect(html).toContain('待确认');
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toContain('GPT Image 快速适配');
    expect(html).toContain('Nano Banana 快速适配');
    expect(html).toContain('grid-cols-1 gap-2 sm:grid-cols-2');
    expect(html).toContain('保存连接后生效');
    expect(html).toContain('质量（可多选）');
    expect(html).toContain('接口默认（省略 quality）');
    expect(html).toContain('auto（自动）');
    expect(html).toContain('自定义质量');
    expect(html).toContain('背景（可多选）');
    expect(html).toContain('接口默认（省略 background）');
    expect(html).toContain('transparent（透明）');
    expect(html).toContain('opaque（不透明）');
    expect(html).toContain('自定义背景');
    expect(html.match(/>应用模板<\/button>/g)).toHaveLength(2);
  });

  it('shows the declared quality and default without selecting other candidates', () => {
    const html = renderToStaticMarkup(createElement(ImageCapabilityEditor, {
      model: { id: 'custom-image', name: 'Custom Image', category: 'image', provider: 'custom',
        imageCapability: { qualities: ['medium'], defaultQuality: 'medium' } },
      onChange: () => undefined, onApplyTemplate: () => undefined, onClose: () => undefined,
    }));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('>medium</button>');
    expect(html).not.toContain('声明可调质量');
  });

  it('keeps an undeclared default when the channel only supports explicit transparent background', () => {
    const html = renderToStaticMarkup(createElement(ImageCapabilityEditor, {
      model: { id: 'custom-image', name: 'Custom Image', category: 'image', provider: 'custom',
        imageCapability: { backgrounds: ['transparent'] } },
      onChange: () => undefined, onApplyTemplate: () => undefined, onClose: () => undefined,
    }));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('transparent（透明）</button>');
    expect(html).toContain('接口默认（省略 background）');
    expect(html).not.toContain('defaultBackground 必须属于');
  });
});
