import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ProviderConnectionForm, { CccGroupConnectionsForm } from '../../src/components/settings/providerConnection/ProviderConnectionForm';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';
import { CCC_PROVIDER_GROUPS } from '../../src/services/ai/cccProviderGroups';

function render(providerId: string, baseUrl = 'https://gateway.example/v1') {
  const definition = getProviderDefinition(providerId);
  if (!definition) throw new Error(`missing provider ${providerId}`);
  return renderToStaticMarkup(
    <ProviderConnectionForm
      editing={false}
      definition={definition}
      isWebSearchProvider={false}
      connectionName="测试连接"
      setConnectionName={vi.fn()}
      chatApiProtocol="anthropic-compatible"
      setChatApiProtocol={vi.fn()}
      apiKey="secret"
      setApiKey={vi.fn()}
      baseUrl={baseUrl}
      setBaseUrl={vi.fn()}
      workflowApiKey=""
      setWorkflowApiKey={vi.fn()}
      dreaminaLoggedIn={false}
      dreaminaLoading={false}
      onDreaminaLogin={vi.fn()}
      duplicateConnectionName=""
      catalogStatus="idle"
      catalogMessage=""
      missingCredentials={false}
      onReturnToPicker={vi.fn()}
      onTestConnection={vi.fn()}
    />,
  );
}

describe('ProviderConnectionForm chat protocol selector', () => {
  it('ToAPIs 默认国内站，两站共享 Key 而非 RunningHub 的独立密钥', () => {
    const html = render('toapis', 'https://toapis.cn/v1');
    expect(html).toContain('国内站（toapis.cn）');
    expect(html).toContain('国际站（toapis.com）');
    expect(html).toContain('共用账号和 API Key');
    expect(html).toContain('切换保留 Key');
    expect(html).not.toContain('两套密钥分别保存');
    expect(html).not.toContain('对话协议');
  });
  it('shows all supported chat protocols for custom connections', () => {
    const html = render('custom-openai');
    expect(html).toContain('对话协议');
    expect(html).toContain('OpenAI 兼容');
    expect(html).toContain('Anthropic 兼容');
    expect(html).toContain('Gemini 原生');
    expect(html).toContain('value="anthropic-compatible" selected=""');
    expect(html).toContain('Anthropic 流式事件');
  });

  it('does not show the selector for built-in providers', () => {
    expect(render('cccapi')).not.toContain('对话协议');
  });

  it('RunningHub 提供国内与国际站点选择，保留已配置的地址', () => {
    const html = render('runninghub-model', 'https://www.runninghub.ai');
    expect(html).toContain('API 站点');
    expect(html).toContain('grid grid-cols-1 gap-3 md:grid-cols-3');
    expect(html).toContain('国内、国际两套密钥分别保存');
    expect(html).toContain('国内站（runninghub.cn）');
    expect(html).toContain('国际站（runninghub.ai）');
    expect(html).toContain('value="https://www.runninghub.ai/openapi/v2" selected=""');
    expect(render('runninghub-model')).toContain('已配置地址');
    expect(render('cccapi')).not.toContain('API 站点');
  });

  it('shows the verified CCC groups and explains independent Key routing', () => {
    const html = renderToStaticMarkup(<CccGroupConnectionsForm providerConfigs={{}} presetModels={[...getProviderDefinition('cccapi')!.models!]} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain('所有已填写分组一起保存');
    for (const group of CCC_PROVIDER_GROUPS) expect(html).toContain(group.name);
    expect(html).toContain('无需切换分组');
    expect(html).toContain('保存全部分组');
    expect(render('grsai')).not.toContain('CCC 分组');
  });
});
