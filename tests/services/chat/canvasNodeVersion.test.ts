/** 节点内容指纹 — 完整编辑输入、运行产物排除与异步快照守卫。 */
import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../../src/types';
import {
  generationInputSnapshot, getCanvasNodeHash, matchesCanvasNodeSnapshot,
} from '../../../src/services/chat/canvasNodeVersion';

function node(data: Partial<BaseNodeData> = {}): Node<BaseNodeData> {
  return { id: 'node-a', type: data.type ?? 'ai-image', position: { x: 100, y: 200 }, data: {
    type: 'ai-image', label: '镜头 A', prompt: '原始提示词', model: 'general/image', status: 'idle', ...data,
  } };
}

function withData(base: Node<BaseNodeData>, patch: Partial<BaseNodeData>): Node<BaseNodeData> {
  return { ...base, data: { ...base.data, ...patch } };
}

function shotlist(): Node<BaseNodeData> {
  return node({ type: 'ai-shotlist', shotlistRows: [
    { id: 'row-a', shotNo: '1', content: '人物走入车站', duration: 3,
      frame: { nodeId: 'image-a', kind: 'image', url: 'https://media.example/a.png', filePath: 'a.png', assetId: 'asset-a' },
      video: { nodeId: 'video-a', kind: 'video', url: 'https://media.example/a.mp4', sourceDuration: 3 } },
    { id: 'row-b', shotNo: '2', content: '列车进入月台', duration: 4 },
  ] });
}

const hash = (value: Node<BaseNodeData>) => getCanvasNodeHash(value, 'project-a');

describe('canvasNodeVersion', () => {
  it('完整提示词尾部和文本正文变化都会使指纹失效', async () => {
    const prefix = '长提示词内容'.repeat(500);
    const original = node({ prompt: `${prefix}保留结尾` });
    const baseline = await hash(original);
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    expect(await hash(withData(original, { prompt: `${prefix}修改结尾` }))).not.toBe(baseline);
    const text = node({ type: 'source-text', output: `${prefix}正文末尾` });
    expect(await hash(withData(text, { output: `${prefix}新的正文` }))).not.toBe(await hash(text));
  });

  it.each([
    { label: '新内部名称' }, { displayLabel: '新可见名称' }, { fileName: '新文件别名' },
    { nodeWidth: 500 }, { nodeHeight: 280 }, { videoResolution: 1024 },
  ])('名称、尺寸或底层生成字段变化使指纹失效：%j', async (patch) => {
    const original = node({ type: 'ai-video', videoResolution: 832, nodeWidth: 280, nodeHeight: 160 });
    expect(await hash(withData(original, patch))).not.toBe(await hash(original));
  });

  it('项目、项目设置和节点位置参与编辑前置条件', async () => {
    const original = node();
    const settings = { defaultModels: { image: 'general/image' } };
    const baseline = await getCanvasNodeHash(original, 'project-a', settings);
    expect(await getCanvasNodeHash(original, 'project-b', settings)).not.toBe(baseline);
    expect(await getCanvasNodeHash(original, 'project-a', { defaultModels: { image: 'general/new-image' } })).not.toBe(baseline);
    expect(await getCanvasNodeHash({ ...original, position: { x: 101, y: 200 } }, 'project-a', settings)).not.toBe(baseline);
  });

  it('分镜文字、顺序、摄影设置和媒体绑定身份变化使指纹失效', async () => {
    const original = shotlist();
    const rows = original.data.shotlistRows!;
    const baseline = await hash(original);
    const variants = [
      [{ ...rows[0], dialogue: '新增对白' }, rows[1]],
      [rows[1], rows[0]],
      [{ ...rows[0], duration: 5 }, rows[1]],
      [{ ...rows[0], frame: { ...rows[0].frame!, nodeId: 'image-b' } }, rows[1]],
      [{ ...rows[0], video: { ...rows[0].video!, nodeId: 'video-b' } }, rows[1]],
    ];
    for (const shotlistRows of variants) expect(await hash(withData(original, { shotlistRows }))).not.toBe(baseline);
    expect(await hash(withData(original, { shotlistColumns: ['shotNo', 'content'] }))).not.toBe(baseline);
    expect(await hash(withData(original, { shotlistCinematography: { focalLengthMm: 85 } }))).not.toBe(baseline);
  });

  it('运行状态和顶层媒体产物不改变编辑指纹', async () => {
    const original = node();
    const changed = withData(original, { status: 'success', error: '过往运行消息', generationStartedAt: 123,
      mediaTaskState: 'paused', mediaTaskStage: 'saving', videoTaskState: 'paused', batchGroupId: 'generated-batch',
      imageUrl: 'https://media.example/new.png', videoUrl: 'https://media.example/new.mp4', audioUrl: 'https://media.example/new.wav',
      thumbnailUrl: 'https://media.example/preview.png', sourceUrl: 'https://media.example/source.png', output: '生成产物地址',
      filePath: 'generated.png', assetId: 'generated-asset', relativePath: 'generated.png', artifactId: 'artifact-a', mediaVersion: 7,
    });
    expect(await hash(changed)).toBe(await hash(original));
  });

  it('分镜媒体快照和分析产物不改变编辑指纹，但仍保留原生成租约快照语义', async () => {
    const original = shotlist();
    const [first, second] = original.data.shotlistRows!;
    const changed = withData(original, { shotlistRows: [{ ...first,
      frame: { ...first.frame!, url: 'https://media.example/refreshed.png', filePath: 'moved.png', assetId: 'moved-asset' },
      video: { ...first.video!, url: 'https://media.example/refreshed.mp4', filePath: 'moved.mp4' },
      frameAnalysis: { sourceVideoNodeId: 'source', requestedTime: 0, actualTime: 0, frameDuration: 0.04, content: '分析产物' },
    }, second] });
    expect(await hash(changed)).toBe(await hash(original));
    expect(generationInputSnapshot(changed.data, undefined)).not.toBe(generationInputSnapshot(original.data, undefined));
  });

  it('生成租约仍跟踪输入与项目设置，忽略名称和自身状态产物', () => {
    const original = node();
    const baseline = generationInputSnapshot(original.data, { defaultModels: { image: 'general/image' } });
    expect(generationInputSnapshot(withData(original, { label: '改名', status: 'loading', imageUrl: 'new.png',
      output: '新产物', batchGroupId: 'batch', mediaTaskStage: 'querying' }).data,
    { defaultModels: { image: 'general/image' } })).toBe(baseline);
    expect(generationInputSnapshot(withData(original, { workflowInputs: { prompt: '新输入' } }).data,
      { defaultModels: { image: 'general/image' } })).not.toBe(baseline);
    expect(generationInputSnapshot(original.data, { defaultModels: { image: 'general/changed' } })).not.toBe(baseline);
  });

  it('异步摘要使用调用时的完整快照，不在摘要等待后重新读取正文', async () => {
    const original = node();
    const baseline = await hash(original);
    const pending = hash(original);
    original.data.prompt = '摘要开始之后的新正文';
    expect(await pending).toBe(baseline);
    expect(await hash(original)).not.toBe(baseline);
  });

  it('摘要等待守卫要求相同节点身份、数据对象和位置', () => {
    const original = node();
    expect(matchesCanvasNodeSnapshot(original, { ...original, position: { ...original.position } })).toBe(true);
    expect(matchesCanvasNodeSnapshot(original, undefined)).toBe(false);
    expect(matchesCanvasNodeSnapshot(original, { ...original, id: 'other' })).toBe(false);
    expect(matchesCanvasNodeSnapshot(original, { ...original, type: 'ai-video' })).toBe(false);
    expect(matchesCanvasNodeSnapshot(original, { ...original, parentId: 'group-a' })).toBe(false);
    expect(matchesCanvasNodeSnapshot(original, withData(original, {}))).toBe(false);
    expect(matchesCanvasNodeSnapshot(original, { ...original, position: { x: 100, y: 201 } })).toBe(false);
  });
});
