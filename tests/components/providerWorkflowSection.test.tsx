import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ProviderWorkflowSection from '../../src/components/settings/providerConnection/ProviderWorkflowSection';

describe('工作流模板表单', () => {
  it('使用工作流术语，保留零种子、范围、画质和比例并说明临时上传', () => {
    const html = renderToStaticMarkup(<ProviderWorkflowSection values={{ seed: 0, duration: 15, resolution: '480p', ratio: '1:1' }} onChange={vi.fn()} />);
    expect(html).toContain('minimax_h3_zm_u24'); expect(html).toContain('max="15"'); expect(html).toContain('value="0"');
    expect(html).toContain('<option selected="">1:1</option>'); expect(html).toContain('临时公网 URL');
    expect(html).not.toContain('模型 ID');
  });
});
