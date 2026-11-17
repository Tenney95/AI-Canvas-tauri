/** 本地对照官方 FormData 与真实万象适配请求；只使用合成素材和 loopback HTTP。 */
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildModelProtocolRequest } from '../../src/services/ai/modelProtocolRequest';
import {
  RELAYON_IMAGE_BASE_URL,
  RELAYON_MODEL_MANIFEST,
  relayonImageVariables,
  resolveRelayonImageExecutionProfile,
} from '../../src/services/ai/providers/relayonModelManifest';

const FIXTURE_KEY = 'fixture-only-not-a-real-key';
// 与既有 modelRequestTransport 用例相同的两份 1×1 PNG，字节不同以识别丢图或顺序改变。
const PNG_FIXTURES = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8Z0AAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
].map((encoded, index) => ({
  encoded,
  filename: `reference-${index + 1}.png`,
  mime: 'image/png',
  bytes: Uint8Array.from(Buffer.from(encoded, 'base64')),
}));

interface ReceivedMultipart {
  method: string | undefined;
  path: string | undefined;
  authorization: string | undefined;
  idempotencyKey: string | string[] | undefined;
  contentType: string;
  wire: Buffer;
  scalars: Array<[string, string]>;
  files: Array<{ field: string; filename: string; mime: string; bytes: number[] }>;
}

async function receiveMultipart(request: IncomingMessage): Promise<ReceivedMultipart> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 16 * 1024) throw new Error('合成对照请求超过 16 KiB');
    chunks.push(bytes);
  }
  const wire = Buffer.concat(chunks);
  const contentType = request.headers['content-type'] ?? '';
  const form = await new Response(Uint8Array.from(wire), {
    headers: { 'Content-Type': contentType },
  }).formData();
  const scalars: Array<[string, string]> = [];
  const files: ReceivedMultipart['files'] = [];
  for (const [field, value] of form.entries()) {
    if (typeof value === 'string') scalars.push([field, value]);
    else files.push({ field, filename: value.name, mime: value.type,
      bytes: Array.from(new Uint8Array(await value.arrayBuffer())) });
  }
  scalars.sort(([left], [right]) => left.localeCompare(right));
  return { method: request.method, path: request.url, authorization: request.headers.authorization,
    idempotencyKey: request.headers['idempotency-key'], contentType, wire, scalars, files };
}

function expectMatchingBoundary(received: ReceivedMultipart): void {
  const match = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))$/i.exec(received.contentType);
  expect(match).not.toBeNull();
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) throw new Error('请求未声明 multipart boundary');
  const wire = received.wire.toString('latin1');
  expect(wire.startsWith(`--${boundary}\r\n`)).toBe(true);
  // Node 各版本的 FormData 末尾 CRLF 不同，两者均须包含自己的最终闭合标记。
  expect(wire.replace(/\r\n$/, '').endsWith(`--${boundary}--`)).toBe(true);
  expect(wire).toContain('Content-Disposition: form-data; name="image[]"; filename="reference-1.png"');
  expect(wire).toContain('Content-Disposition: form-data; name="image[]"; filename="reference-2.png"');
}

describe('RelayOn multipart 本地协议对照', () => {
  it.each(['image-2.6-01', 'image-2.6-flare-01', 'image-2.6-sunburst-01'])(
    '%s 的真实适配请求与官方 Node FormData 保留相同字段及参考图原件', async (modelId) => {
      const model = RELAYON_MODEL_MANIFEST.find((entry) => entry.id === modelId);
      if (!model?.executionProfile) throw new Error(`缺少内置模型合同 ${modelId}`);
      const nonce = process.env.AI_CANVAS_MULTIPART_NONCE ?? randomUUID();
      const idempotencyKey = `fixture-multipart-${modelId}`;
      const fields = { model: modelId, prompt: `两份合成参考图的本地协议对照 ${nonce}`, size: '2560x1440', n: 1, response_format: 'url' };
      const variables = relayonImageVariables(modelId, { model: modelId, prompt: fields.prompt,
        imageSize: '2K', aspectRatio: '16:9', n: 1,
        imageUrls: PNG_FIXTURES.map((file) => `data:${file.mime};base64,${file.encoded}`) });
      const profile = resolveRelayonImageExecutionProfile(modelId, model.executionProfile, PNG_FIXTURES.length);
      if (!profile?.protocol) throw new Error(`缺少图片文件编辑协议 ${modelId}`);
      const built = buildModelProtocolRequest({ baseUrl: RELAYON_IMAGE_BASE_URL, apiKey: FIXTURE_KEY,
        protocol: profile.protocol, variables, idempotencyKey });
      // 官方 URL 只断言；下面的两次真实 HTTP 请求都覆盖为随机 loopback 接收地址。
      expect(built.url).toBe('https://api.relayonapi.com/v1/images/edits');

      const official = new FormData();
      for (const [field, value] of Object.entries(fields)) official.set(field, String(value));
      for (const file of PNG_FIXTURES) {
        official.append('image[]', new Blob([file.bytes], { type: file.mime }), file.filename);
      }
      const received: ReceivedMultipart[] = [];
      const failures: unknown[] = [];
      const server = createServer((request, response) => {
        void receiveMultipart(request).then((captured) => {
          received.push(captured);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ received: true, trace: captured.scalars.find(([key]) => key === 'prompt')?.[1] }));
        }).catch((error: unknown) => {
          failures.push(error);
          if (!response.destroyed) { response.writeHead(400); response.end('合成对照请求解析失败'); }
        });
      });
      server.requestTimeout = 2_000;
      server.headersTimeout = 2_000;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('本地对照接收器没有随机端口');
        const url = `http://127.0.0.1:${address.port}/v1/images/edits`;
        for (const init of [
          { method: 'POST', headers: { Authorization: `Bearer ${FIXTURE_KEY}`, 'Idempotency-Key': idempotencyKey }, body: official },
          built.init,
        ]) {
          const response = await fetch(url, { ...init, signal: AbortSignal.timeout(2_000) });
          const reply: unknown = await response.json();
          expect(response.status).toBe(200);
          expect(reply).toEqual({ received: true, trace: fields.prompt });
        }
        expect(failures).toEqual([]);
        expect(received).toHaveLength(2);
        const expectedScalars = Object.entries(fields).map(([key, value]): [string, string] => [key, String(value)])
          .sort(([left], [right]) => left.localeCompare(right));
        const expectedFiles = PNG_FIXTURES.map((file) => ({ field: 'image[]', filename: file.filename,
          mime: file.mime, bytes: Array.from(file.bytes) }));
        for (const request of received) {
          expectMatchingBoundary(request);
          expect(request).toMatchObject({ method: 'POST', path: '/v1/images/edits',
            authorization: `Bearer ${FIXTURE_KEY}`, idempotencyKey });
          expect({ scalars: request.scalars, files: request.files }).toEqual({ scalars: expectedScalars, files: expectedFiles });
        }
        expect(received[1].scalars).toEqual(received[0].scalars);
        expect(received[1].files).toEqual(received[0].files);
        console.info(`MULTIPART_CONFORMANCE model=${modelId} files=2 trace=${nonce} HTTP=200 exact=true`);
      } finally {
        if (server.listening) await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
    }, 8_000,
  );
});
