import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePluginBundle } from '../../src/services/plugins/pluginManifest';
import { buildChatApiRequest } from '../../src/services/ai/chatApiProtocol';

const execFileAsync = promisify(execFile);
const pluginCli = fileURLToPath(new URL('../../scripts/plugin-dev.mjs', import.meta.url));

describe('independent Responses plugin package', () => {
  const packageDirectory = process.env.AI_CANVAS_RESPONSES_PLUGIN_DIR;
  let temporary: string | undefined;
  let text: string;
  let source: string;
  let manifest: ReturnType<typeof parsePluginBundle>;

  beforeAll(async () => {
    let directory: string;
    if (packageDirectory !== undefined) {
      directory = resolve(packageDirectory);
    } else {
      temporary = await mkdtemp(join(tmpdir(), 'ai-canvas-responses-package-'));
      directory = join(temporary, 'plugin');
    }
    const args = packageDirectory === undefined ? ['init', directory, 'protocol'] : ['check', directory];
    await execFileAsync(process.execPath, [pluginCli, ...args], { windowsHide: true, timeout: 20000 });
    [text, source] = await Promise.all([
      readFile(join(directory, 'manifest.json'), 'utf8'),
      readFile(join(directory, 'main.js'), 'utf8'),
    ]);
    manifest = parsePluginBundle(text, source);
  }, 25000);

  afterAll(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  it('ships a standalone permission-free preset package with a no-op entry', () => {
    const id = packageDirectory !== undefined ? 'ai-canvas.openai-responses' : 'com.example.openai-responses';
    expect(manifest).toMatchObject({ id, apiVersion: 2, permissions: [], requiredCapabilities: ['model.protocolPresets'],
      contributes: { nodeTools: [], modelProtocols: [{ id: 'responses', category: 'text', adapter: 'openai-responses' }] } });
    const entry = new Script(`const definitions = [];
      const definePlugin = (value) => definitions.push(value);
      ${source}
      JSON.stringify(definitions);`);
    expect(entry.runInNewContext(Object.create(null), {
      timeout: 1000,
      contextCodeGeneration: { strings: false, wasm: false },
    })).toBe('[{"tools":{}}]');
    expect(text + source).not.toMatch(/AI_CANVAS_MCP_TOKEN|apiKey|[A-Z]:\\/u);
  });
  it('binds to the host encoder that preserves all five image inputs', () => {
    const images = Array.from({ length: 5 }, (_, i) => `data:image/png;base64,${i}AAA`);
    const request = buildChatApiRequest({ protocol: manifest.contributes.modelProtocols![0].adapter, apiKey: '', baseUrl: 'https://api.example/v1', model: 'configured-model', stream: false,
      messages: [{ role: 'system', content: '逐张分析' }, { role: 'user', content: [{ type: 'text', text: '五张图片' }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] }] });
    const body = JSON.parse(String(request.init.body));
    expect(request.url).toBe('https://api.example/v1/responses');
    expect(body.input[1].content.filter((part: { type: string }) => part.type === 'input_image').map((part: { image_url: string }) => part.image_url)).toEqual(images);
  });
});
