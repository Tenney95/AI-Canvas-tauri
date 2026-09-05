import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentStep, ProviderModelChoice } from '../../src/types/agent';
import AgentApprovalCard from '../../src/components/chat/AgentApprovalCard';
import { queryProviderModels, toggleProviderModelSelection } from '../../src/services/chat/providerModelCatalogService';

const options: ProviderModelChoice[] = Array.from({ length: 1000 }, (_, index) => ({ id: `m-${index}`, name: `Model ${index}`, category: 'text' }));
function step(expiresAt = Date.now() + 60_000): AgentStep {
  return { id: 'step', taskId: 'task', index: 0, kind: 'approval', title: '选择模型', status: 'waiting_approval', createdAt: 1, updatedAt: 1,
    approval: { id: 'approval', kind: 'user_choice', status: 'pending', summary: '选择模型', requestedAt: 1,
      inputRequest: { kind: 'provider_models', options, maxSelection: 16,
        catalog: { catalogId: 'catalog', total: 1000, categoryCounts: { text: 1000, image: 0, video: 0, audio: 0 }, maxSelection: 16, expiresAt } } } };
}
const render = (value: AgentStep) => renderToStaticMarkup(<AgentApprovalCard step={value} mediaModelOptions={[]} mediaModelAvailability={{}} onResolve={vi.fn()} />);
describe('AgentApprovalCard provider catalog', () => {
  it('renders only one page with search, categories, paging and the selection limit', () => {
    const markup = render(step());
    expect(markup).toContain('搜索模型名称或 ID');
    expect(markup).toContain('全部分类');
    expect(markup).toContain('下一页');
    expect(markup).toContain('每批最多 16 个');
    expect(markup.match(/type="checkbox"/g)).toHaveLength(20);
    expect(markup).not.toContain('Model 999');
    expect(markup).not.toContain('checked=""');
  });
  it('preserves selection across filtered pages and only submits chosen IDs through existing snapshot data', () => {
    const snapshot = JSON.parse(JSON.stringify(step())) as AgentStep;
    const request = snapshot.approval!.inputRequest!;
    if (request.kind !== 'provider_models') throw new Error('wrong request');
    let selected = toggleProviderModelSelection([], [queryProviderModels(request.options).options[0].id]);
    const match = queryProviderModels(request.options, 'm-999', 'text');
    selected = toggleProviderModelSelection(selected, [match.options[0].id]);
    expect(selected).toEqual(['m-0', 'm-999']);
    expect(render(snapshot)).toContain('下一页');
  });
  it('shows expired catalogs and disables confirmation', () => {
    const markup = render(step(1));
    expect(markup).toContain('模型目录已过期');
    expect(markup).toMatch(/disabled=""[^>]*>接入选中的 0 个模型/);
  });
});
