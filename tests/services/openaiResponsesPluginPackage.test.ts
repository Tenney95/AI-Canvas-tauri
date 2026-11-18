/** 实际独立交付物位于源码仓库旁；普通源码 CI 不要求本机插件目录存在。 */
import { existsSync, readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parsePluginBundle } from '../../src/services/plugins/pluginManifest';
import { buildChatApiRequest } from '../../src/services/ai/chatApiProtocol';

const directory = new URL('../../../plugins/openai-responses/', import.meta.url);
describe.runIf(existsSync(new URL('manifest.json', directory)))('independent Responses plugin package', () => {
  it('ships a standalone permission-free preset package with a no-op entry', () => {
    const text = readFileSync(new URL('manifest.json', directory), 'utf8');
    const source = readFileSync(new URL('main.js', directory), 'utf8');
    const manifest = parsePluginBundle(text, source);
    expect(manifest).toMatchObject({ id: 'ai-canvas.openai-responses', apiVersion: 2, permissions: [], requiredCapabilities: ['model.protocolPresets'],
      contributes: { nodeTools: [], modelProtocols: [{ id: 'responses', category: 'text', adapter: 'openai-responses' }] } });
    const definitions: unknown[] = [];
    new Script(source).runInNewContext({ definePlugin: (value: unknown) => definitions.push(value) });
    expect(JSON.stringify(definitions)).toBe('[{"tools":{}}]');
    expect(text + source).not.toMatch(/AI_CANVAS_MCP_TOKEN|apiKey|[A-Z]:\\/u);
  });
  it('binds to the host encoder that preserves all five image inputs', () => {
    const manifest = parsePluginBundle(readFileSync(new URL('manifest.json', directory), 'utf8'), readFileSync(new URL('main.js', directory), 'utf8'));
    const images = Array.from({ length: 5 }, (_, i) => `data:image/png;base64,${i}AAA`);
    const request = buildChatApiRequest({ protocol: manifest.contributes.modelProtocols![0].adapter, apiKey: '', baseUrl: 'https://api.example/v1', model: 'configured-model', stream: false,
      messages: [{ role: 'system', content: '逐张分析' }, { role: 'user', content: [{ type: 'text', text: '五张图片' }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] }] });
    const body = JSON.parse(String(request.init.body));
    expect(request.url).toBe('https://api.example/v1/responses');
    expect(body.input[1].content.filter((part: { type: string }) => part.type === 'input_image').map((part: { image_url: string }) => part.image_url)).toEqual(images);
  });
});
