import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ProviderConnectionForm from '../../src/components/settings/providerConnection/ProviderConnectionForm';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';

function render(providerId: string) {
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
      baseUrl="https://gateway.example/v1"
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
});
