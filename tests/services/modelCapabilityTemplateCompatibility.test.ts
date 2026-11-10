/** 只冻结公开内置目录与显式快速模板，不读取用户配置或发起模型请求。 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TOAPIS_MODEL_MANIFEST } from '../../src/services/ai/providers/toapisModelManifest';
import { LIBAPI_MODEL_MANIFEST } from '../../src/services/ai/providers/libapiModelManifest';
import { RELAYON_MODEL_MANIFEST } from '../../src/services/ai/providers/relayonModelManifest';
import { AIGCSI_MODEL_MANIFEST } from '../../src/services/ai/providers/aigcsiModelManifest';
import { SORA2U_MODEL_MANIFEST } from '../../src/services/ai/providers/sora2uModelManifest';
import { RUNNINGHUB_MODEL_MANIFEST } from '../../src/services/ai/providers/runninghubModelManifest';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';
import { getGrsaiImageCapability, getGrsaiVideoCapability } from '../../src/services/ai/grsaiModels';
import { IMAGE_QUICK_ADAPT_OPTIONS, createImageQuickAdaptTemplate } from '../../src/services/ai/imageModelTemplates';
import { getImageCapability } from '../../src/services/ai/mediaModelCapabilities';

const IMAGE_SAMPLE_IDS = [
  'gpt-image-1', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst',
  'gemini-2.5-flash-image-preview', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview',
  'doubao-seedream-4.0', 'doubao-seedream-4.5', 'doubao-seedream-5.0-lite', 'doubao-seedream-5.0-pro',
  ...[
    'gpt-image-1', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-1-official', 'gpt-image-1.5-official', 'gpt-image-2-official',
    'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'gpt-image-2.5-ext',
    'gemini-3.1-flash-lite-image', 'gemini-3.1-flash-lite-image-ext',
    'gemini-3.1-flash-image-preview', 'gemini-3.1-flash-image-preview-official',
    'gemini-3-pro-image-preview', 'gemini-3-pro-image-preview-official', 'gemini-2.5-flash-image-preview',
    'seedream-5-0-pro', 'seedream-5-0-flash', 'doubao-seedream-4.0', 'doubao-seedream-4.5',
  ].map((id) => `apimart/${id}`),
];

const GRSAI_IMAGE_SAMPLE_IDS = [
  'nano-banana-2.1', 'nano-banana-2', 'nano-banana-pro', 'nano-banana-2-lite', 'nano-banana-fast',
  'nano-banana-2-cl', 'nano-banana-pro-cl', 'nano-banana-2-2k-cl', 'nano-banana-2-4k-cl',
  'nano-banana-pro-4k-vip', 'nano-banana-pro-vip',
  'gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.6', 'gpt-image-2-vip', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst',
];

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : entry);
}

function withoutDimensionPresets(value: ReturnType<typeof getGrsaiImageCapability>) {
  if (!value) return value;
  const result = { ...value };
  delete result.dimensionPresets;
  return result;
}

const PUBLIC_CONTRACTS = {
  toapis: TOAPIS_MODEL_MANIFEST,
  libapi: LIBAPI_MODEL_MANIFEST,
  relayon: RELAYON_MODEL_MANIFEST,
  aigcsi: AIGCSI_MODEL_MANIFEST,
  sora2u: SORA2U_MODEL_MANIFEST,
  runninghub: RUNNINGHUB_MODEL_MANIFEST,
  ccc: getProviderDefinition('cccapi')!.models!,
  grsaiVideo: [undefined, '480p', '768p', '1080p'].map((resolution) => ({
    resolution, capability: getGrsaiVideoCapability('minimax-h3', resolution),
  })),
  imageTemplates: IMAGE_QUICK_ADAPT_OPTIONS.map((option) => ({ id: option.id, template: createImageQuickAdaptTemplate(option.id) })),
  imageSamples: IMAGE_SAMPLE_IDS.map((id) => ({ id, capability: getImageCapability(id) })),
  grsaiImages: GRSAI_IMAGE_SAMPLE_IDS.map((id) => ({ id, capability: withoutDimensionPresets(getGrsaiImageCapability(id)) })),
};

// 来自独立 detached worktree 的 4b00f146 原合同。JSON 语义忽略 undefined 与对象键顺序，保留数组顺序。
// 有意变更渠道合同时需明确核对并更新摘要；不能用当前实现重新生成来掩盖兼容性变化。
const BASELINE = {
  toapis: [88, '070c57e7871460bc94b30cf8aae7503368a42549d2bc57ed66d8aa5a503b31bc'],
  libapi: [67, '3faf89e7dec462002deb9b8a2ec903c9681565f0c414e4387fe699c24f34be61'],
  relayon: [30, '80be2d653ee37d26592fc506619d302e7efd0c5e848f80859c502a509f46c034'],
  aigcsi: [21, '97449c478afea8efb174486dfe8f778bfcc8fb99d1bc0c0be735e83370e2d430'],
  sora2u: [9, 'bfcd6fc46796da2556b4c3159e2975480b4c92f4a19d3103e61122c17dff711d'],
  runninghub: [347, '662eb139544f7aed05d65bea84dd33c4b76c5ea95f9087ab72569a01931f389a'],
  ccc: [85, '48cc3fce182243d81521221bfe80ed9fbdd400504e23e49bcb0734a12b058016'],
  grsaiVideo: [4, '9ed1bd6b32bbaf80600468638354ea490ea3c983e6fad5398125d49939ba6d34'],
  imageTemplates: [18, '3f50cb4221a8caa468ac676fa1024d8c9b3aae794c3028921acf23e216ea67d1'],
  imageSamples: [34, 'd9ad2ff2daf65f4db8b0db7464602dd91ec552e4fa167ecb741e7277edafb1ae'],
  grsaiImages: [17, 'ac52b2acba59a665654fa17c702dbdf6296ea87f78322413ce07f1a1b230b21e'],
} as const;

describe('基础模板与渠道覆写的旧合同兼容', () => {
  it.each(Object.entries(PUBLIC_CONTRACTS))('%s 保留旧合同、默认值、协议与候选顺序', (name, contracts) => {
    const [count, digest] = BASELINE[name as keyof typeof BASELINE];
    expect(contracts).toHaveLength(count);
    expect(createHash('sha256').update(stableJson(contracts)).digest('hex')).toBe(digest);
  });
});
