import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ProviderWorkflowSection from '../../src/components/settings/providerConnection/ProviderWorkflowSection';
import { createWorkflowApiDraft } from '../../src/services/workflowApi/workflowApiDefinition';

describe('工作流模板表单', () => {
  it('提供可选 H3 模板、通用协议编辑和素材上传说明', () => {
    const html = renderToStaticMarkup(<ProviderWorkflowSection drafts={[createWorkflowApiDraft('autodl')]} onChange={vi.fn()} onValidityChange={vi.fn()} />);
    expect(html).toContain('/api/v1/comfyui/comfyui_workflow/minimax_h3_zm_u24');
    expect(html).toContain('添加自定义工作流'); expect(html).toContain('编辑调用路径与参数映射');
    expect(html).toContain('480p(1:1)'); expect(html).toContain('临时公网 URL');
    expect(html).not.toContain('模型 ID');
  });
});
