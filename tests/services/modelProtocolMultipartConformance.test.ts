/** 本地对照官方 FormData 与真实万象适配请求；只使用合成素材和 loopback HTTP。 */
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as httpTransport from '../../src/services/ai/httpTransport';
import * as fileService from '../../src/services/fileService';
import { pcmS16LeToWav } from '../../src/services/ai/modelProtocolHttp';
import { prepareProtocolMediaFileRequest } from '../../src/services/ai/modelProtocolMediaFiles';
import { buildModelProtocolRequest, previewModelProtocolRequest, renderRequestBody } from '../../src/services/ai/modelProtocolRequest';
import { prepareRelayonVideoSubmission } from '../../src/services/ai/modelProtocol';
import { prepareRelayonVideoUpload } from '../../src/services/ai/providers/relayonVideoUpload';
import { PREPARED_MULTIPART_FILES } from '../../src/services/ai/modelProtocolTemplate';
import type { ModelExecutionProtocol } from '../../src/types/aiTypes';
import {
  RELAYON_IMAGE_BASE_URL,
  RELAYON_MODEL_MANIFEST,
  RELAYON_VIDEO_BASE_URL,
  relayonImageVariables,
  resolveRelayonImageExecutionProfile,
  resolveRelayonVideoExecutionProfile,
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

describe('自定义 multipart 文件字段', () => {
  const protocol: ModelExecutionProtocol = {
    version: 1, mode: 'sync', resultUrlPath: 'url',
    submit: {
      method: 'POST', path: '/videos', bodyEncoding: 'multipart',
      body: {
        prompt: '{{prompt}}',
        first_frame: { $file: '{{firstImage}}', filename: 'first.png' },
        images: [
          { $file: '{{referenceImageUrls.0}}', filename: 'one.png' },
          { $file: '{{referenceImageUrls.1}}', filename: 'two.png' },
        ],
        videos: { $file: '{{videoUrls}}' },
        metadata: { nested: { $file: '{{firstImage}}', filename: 'metadata' } },
      },
    },
  };

  it.each(['file:///private/clip.mp4', 'https://asset.localhost/C%3A%5Cmedia%5Cclip.mp4'])(
    '试跑在读取前拒绝本地文件来源 %s', async (url) => {
      const localRead = vi.spyOn(fileService, 'readFileToDataUrl').mockRejectedValue(new Error('不应读取文件'));
      const download = vi.spyOn(httpTransport, 'corsSafeFetch').mockRejectedValue(new Error('不应下载文件'));
      await expect(prepareProtocolMediaFileRequest(protocol, { videoUrls: [url] }, { trial: true }))
        .rejects.toThrow('试跑文件仅支持');
      expect(localRead).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
    },
  );

  it('远程音视频按声明顺序直接成为表单文件，读取 CDN 不附带凭据', async () => {
    const { Output, BufferTarget, Mp4OutputFormat, EncodedVideoPacketSource, EncodedPacket } = await import('mediabunny');
    const target = new BufferTarget();
    const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: 'in-memory' }) });
    const track = new EncodedVideoPacketSource('vp9');
    output.addVideoTrack(track);
    await output.start();
    await track.add(new EncodedPacket(new Uint8Array([0x82, 0x49, 0x83, 0x42, 0, 0, 0]), 'key', 0, 1), {
      decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
    });
    track.close();
    await output.finalize();
    const clip = 'https://media.example/clip.mp4';
    const voices = ['https://media.example/second.wav', 'https://media.example/first.wav'];
    const bytes = [
      new Uint8Array(target.buffer!),
      ...[2, 1].map((sample) => Uint8Array.from(pcmS16LeToWav(new Uint8Array([sample, 0]), 24000, 1))),
    ];
    const urls = [clip, ...voices];
    const download = vi.spyOn(httpTransport, 'corsSafeFetch').mockImplementation(async (url) => {
      const index = urls.indexOf(url);
      if (index < 0) throw new Error('意外的素材地址');
      return new Response(bytes[index], { headers: { 'Content-Type': 'application/octet-stream' } });
    });
    const custom = { ...protocol, submit: { ...protocol.submit, body: {
      clip: { $file: '{{videoUrls.0}}' }, voices: { $file: '{{audioUrls}}' },
    } } };
    const signal = new AbortController().signal;
    const prepared = await prepareProtocolMediaFileRequest(custom, { videoUrls: [clip], audioUrls: voices }, { signal });
    expect(download.mock.calls).toEqual(urls.map((url) => [url, { credentials: 'omit', signal }, { sensitive: true }]));
    const { init } = buildModelProtocolRequest({ baseUrl: 'https://gateway.example', apiKey: FIXTURE_KEY,
      protocol: custom, variables: prepared.variables });
    const form = await new Response(init.body, { headers: init.headers }).formData();
    expect([...form.keys()]).toEqual(['clip', 'voices', 'voices']);
    const files = [...form.values()].map((file) => {
      if (typeof file === 'string') throw new Error('收到普通表单文本，期望文件');
      return file;
    });
    expect(files.map((file) => file.type)).toEqual(['video/mp4', 'audio/wav', 'audio/wav']);
    expect(await Promise.all(files.map(async (file) => new Uint8Array(await file.arrayBuffer())))).toEqual(bytes);
  });

  it('没有选中的文件从预览和请求中一起省略，普通 JSON 字段仍然照原样渲染', async () => {
    const image = PNG_FIXTURES[0];
    const options = {
      baseUrl: 'https://gateway.example', protocol,
      variables: { prompt: '视频', referenceImageUrls: [`data:${image.mime};base64,${image.encoded}`], videoUrls: [] },
    };
    const preview = previewModelProtocolRequest(options);
    expect(preview.body).toEqual({
      prompt: '视频', images: [{ $file: `[data URL image/png, ${image.bytes.length} bytes]`, filename: 'one.png' }],
      metadata: { nested: { filename: 'metadata' } },
    });
    const { init } = buildModelProtocolRequest({ ...options, apiKey: FIXTURE_KEY });
    const form = await new Response(init.body, { headers: init.headers }).formData();
    expect([...form.keys()]).toEqual(['prompt', 'images', 'metadata']);
    expect(form.get('images')).toMatchObject({ name: 'one.png', type: image.mime, size: image.bytes.length });
    expect(form.get('metadata')).toBe('{"nested":{"filename":"metadata"}}');
    expect(() => buildModelProtocolRequest({ ...options, apiKey: FIXTURE_KEY,
      variables: { ...options.variables, firstImage: 'https://example.com/image.png' },
    })).toThrow('multipart 文件只支持 data URL');
  });

  it.each(['json', 'form-urlencoded'] as const)('%s 的普通字段仍只省略缺失变量本身', (bodyEncoding) => {
    const request = { ...protocol.submit, bodyEncoding, body: { reference: { $file: '{{firstImage}}', filename: 'first.png' } } };
    expect(renderRequestBody(request, {})).toEqual({ reference: { filename: 'first.png' } });
  });

  it('同一变量作为文件时使用准备好的字节，作为普通字段时保留原地址', async () => {
    const image = PNG_FIXTURES[0];
    const url = 'https://cdn.example/first.png';
    const request = { ...protocol.submit, body: {
      frame: { $file: '{{ imageUrls.0 }}', filename: 'frame.png' },
      original: '{{imageUrls.0}}',
    } };
    const variables = {
      imageUrls: [url],
      [PREPARED_MULTIPART_FILES]: { 'imageUrls.0': `data:${image.mime};base64,${image.encoded}` },
    };
    const options = {
      protocol: { ...protocol, submit: request }, variables, baseUrl: 'https://gateway.example', apiKey: FIXTURE_KEY,
    };
    const { init } = buildModelProtocolRequest(options);
    expect(previewModelProtocolRequest(options).body).toEqual({
      frame: { $file: `[data URL image/png, ${image.bytes.length} bytes]`, filename: 'frame.png' }, original: url,
    });
    const form = await new Response(init.body, { headers: init.headers }).formData();
    expect([...form.keys()]).toEqual(['frame', 'original']);
    const file = form.get('frame');
    if (!file || typeof file === 'string') throw new Error('未收到参考文件');
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(Array.from(image.bytes));
    expect(form.get('original')).toBe(url);
    expect(renderRequestBody({ ...request, bodyEncoding: 'json' }, variables)).toEqual({
      frame: { $file: url, filename: 'frame.png' }, original: url,
    });
  });
});

describe('RelayOn multipart 本地协议对照', () => {
  it('视频预检仅渲染表单字段，提交时按原顺序发送文件并解析原任务 ID', async () => {
    const model = RELAYON_MODEL_MANIFEST.find((entry) => entry.id === 'sd-2.0-c1')!;
    const upload = await prepareRelayonVideoUpload(PNG_FIXTURES.map((file) => ({
      kind: 'image', role: 'reference', origin: 'connection', url: `data:image/png;base64,${file.encoded}`,
    })));
    if (!upload) throw new Error('未准备参考图');
    const variables = { model: model.id, prompt: '参考图1和图2', referenceImageUrls: upload.references.map((ref) => ref.url) };
    const profile = resolveRelayonVideoExecutionProfile(model.id, model.executionProfile, variables, true);
    if (!profile?.protocol) throw new Error('未找到万象视频协议');
    try {
      const options = { apiKey: FIXTURE_KEY, baseUrl: RELAYON_VIDEO_BASE_URL, protocol: profile.protocol,
        variables, relayonUpload: upload, idempotencyKey: 'fixture-video-upload' };
      const built = prepareRelayonVideoSubmission(options);
      expect(built.renderedBody).toMatchObject({ images: variables.referenceImageUrls.map(($file, i) => ({
        $file, filename: `reference-image-${i + 1}.png`,
      })) });
      const post = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        expect(String(url)).toBe(`${RELAYON_VIDEO_BASE_URL}/videos`);
        expect(new Headers(init?.headers).get('idempotency-key')).toBe('fixture-video-upload');
        const form = init?.body as FormData;
        const files = form.getAll('images') as File[];
        expect(await Promise.all(files.map(async (file) => Array.from(new Uint8Array(await file.arrayBuffer())))))
          .toEqual(PNG_FIXTURES.map((file) => [...file.bytes]));
        return Response.json({ id: 'fixture-video-result' });
      });
      try {
        const submitted = await built.submit();
        expect(submitted.taskId).toBe('fixture-video-result');
        expect(post).toHaveBeenCalledOnce();
      } finally { post.mockRestore(); }
    } finally { await upload.release(); }
  });

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
