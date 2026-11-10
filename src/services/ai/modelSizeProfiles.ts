/** 图片尺寸源表。相同型号在不同渠道的像素合同仍分别命名，不按模型名混用。 */
import type { ImageModelCapability } from '../../types/aiTypes';

type ImageDimensions = NonNullable<ImageModelCapability['dimensionPresets']>;
type PixelPair = readonly [number, number];
type PixelTiers = readonly [PixelPair, PixelPair, PixelPair];

export type ImageSizeProfile = 'openai-gpt' | 'apimart-gpt-2.5' | 'toapis-gpt-2.5'
  | 'relayon-image-2' | 'relayon-image-2.5'
  | 'relayon-nano-banana' | 'relayon-seedream-5-pro' | 'relayon-midjourney' | 'relayon-midjourney-8'
  | 'grsai-gpt' | 'grsai-gpt-base'
  | 'volcengine-seedream-5-pro' | 'apimart-seedream-5'
  | 'google-gemini-2.5-flash' | 'google-gemini-3-pro' | 'google-nano-banana-2.1';

// 客户端选择的合法组合；官方模板遵守 16 对齐、比例与总像素限制。
// https://developers.openai.com/api/docs/guides/image-generation
const GPT_DIMENSIONS: ImageDimensions = {
  '1K': {
    '1:1': [1024, 1024], '3:2': [1536, 1024], '2:3': [1024, 1536],
    '4:3': [1024, 768], '3:4': [768, 1024], '5:4': [1280, 1024], '4:5': [1024, 1280],
    '16:9': [1536, 864], '9:16': [864, 1536], '2:1': [1536, 768], '1:2': [768, 1536],
    '21:9': [2016, 864], '9:21': [864, 2016], '3:1': [1536, 512], '1:3': [512, 1536],
  },
  '2K': {
    '1:1': [2048, 2048], '3:2': [2048, 1360], '2:3': [1360, 2048],
    '4:3': [2048, 1536], '3:4': [1536, 2048], '5:4': [2560, 2048], '4:5': [2048, 2560],
    '16:9': [2048, 1152], '9:16': [1152, 2048], '2:1': [2688, 1344], '1:2': [1344, 2688],
    '21:9': [2688, 1152], '9:21': [1152, 2688], '3:1': [3072, 1024], '1:3': [1024, 3072],
  },
  '4K': {
    '1:1': [2880, 2880], '3:2': [3520, 2336], '2:3': [2336, 3520],
    '4:3': [3312, 2480], '3:4': [2480, 3312], '5:4': [3216, 2576], '4:5': [2576, 3216],
    '16:9': [3840, 2160], '9:16': [2160, 3840], '2:1': [3840, 1920], '1:2': [1920, 3840],
    '21:9': [3840, 1648], '9:21': [1648, 3840], '3:1': [3840, 1280], '1:3': [1280, 3840],
  },
};

// APIMart 的 1K 宽幅尺寸与官方模板不同；其余行经既有合同逐项保留。
// https://docs.apimart.ai/cn/api-reference/images/gpt-image-2.5/generation
const APIMART_GPT_DIMENSIONS: ImageDimensions = {
  '1k': { ...GPT_DIMENSIONS['1K'], '2:1': [2048, 1024], '1:2': [1024, 2048] },
  '2k': GPT_DIMENSIONS['2K'],
  '4k': GPT_DIMENSIONS['4K'],
};

// ToAPIs VIP/official 只声明这些比例，不扩展为其他渠道的完整集合。
// https://docs.toapis.com/docs/cn/api-reference/images/gpt-image-2.5-official/generation
const TOAPIS_GPT_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '21:9'];
const TOAPIS_GPT_DIMENSIONS: ImageDimensions = Object.fromEntries(Object.entries(GPT_DIMENSIONS).map(([resolution, ratios]) => [
  resolution, Object.fromEntries(TOAPIS_GPT_RATIOS.map((ratio) => [ratio, ratios[ratio]])),
]));

// Google 官方完整尺寸表（2026-11-10）。2.5 Flash 不能沿用后续型号的像素。
// https://ai.google.dev/gemini-api/docs/image-generation#aspect-ratios-and-image-size
const GOOGLE_25_FLASH_PIXELS: Record<string, PixelPair> = {
  '1:1': [1024, 1024], '2:3': [832, 1248], '3:2': [1248, 832],
  '3:4': [864, 1184], '4:3': [1184, 864], '4:5': [896, 1152], '5:4': [1152, 896],
  '9:16': [768, 1344], '16:9': [1344, 768], '21:9': [1536, 672],
};
const GOOGLE_3_PRO_PIXELS: Record<string, PixelPair> = {
  '1:1': [1024, 1024], '2:3': [848, 1264], '3:2': [1264, 848],
  '3:4': [896, 1200], '4:3': [1200, 896], '4:5': [928, 1152], '5:4': [1152, 928],
  '9:16': [768, 1376], '16:9': [1376, 768], '21:9': [1584, 672],
};
const GOOGLE_NANO_21_PIXELS: Record<string, PixelPair> = {
  ...GOOGLE_3_PRO_PIXELS,
  '1:4': [512, 2048], '4:1': [2048, 512], '1:8': [384, 3072], '8:1': [3072, 384],
};

// 3 Pro、2.1 与 3.1 Flash 的 1K/2K/4K 已逐行核对，每维正好为 1/2/4 倍。
// 3.1 Flash 的 512/21:9 官方行存在疑点，不在此生成或纠正该尺寸表。
function googlePixelScales(pixels: Record<string, PixelPair>): ImageDimensions {
  return Object.fromEntries([1, 2, 4].map((scale) => [`${scale}K`,
    Object.fromEntries(Object.entries(pixels).map(([ratio, [width, height]]) => [ratio,
      [width * scale, height * scale] as [number, number],
    ])),
  ]));
}

// RelayOnAPI 逐档尺寸，独立于官方/APIMart 的同名型号。https://relayonapi.com/docs
const RELAYON_COMMON_PIXELS: Record<string, PixelTiers> = {
  '1:1': [[1024, 1024], [2048, 2048], [2880, 2880]],
  '4:3': [[1152, 864], [2048, 1536], [3264, 2448]],
  '3:2': [[1248, 832], [2016, 1344], [3456, 2304]],
  '16:9': [[1280, 720], [2048, 1152], [3840, 2160]],
  '21:9': [[1344, 576], [2016, 864], [3808, 1632]],
  '3:4': [[864, 1152], [1536, 2048], [2448, 3264]],
  '2:3': [[832, 1248], [1344, 2016], [2304, 3456]],
  '9:16': [[720, 1280], [1152, 2048], [2160, 3840]],
};

function imagePixelTiers(rows: Record<string, PixelTiers>): ImageDimensions {
  return Object.fromEntries(['1K', '2K', '4K'].map((resolution, index) => [resolution,
    Object.fromEntries(Object.entries(rows).map(([ratio, sizes]) => [ratio, [...sizes[index]] as [number, number]])),
  ]));
}

const RELAYON_NANO_PIXELS: Record<string, PixelPair> = {
  '1:1': [1024, 1024], '2:3': [832, 1248], '3:2': [1248, 832], '3:4': [864, 1152],
  '4:3': [1152, 864], '4:5': [1024, 1280], '5:4': [1280, 1024], '9:16': [720, 1280],
  '16:9': [1280, 720], '21:9': [1344, 576],
};
const RELAYON_MJ_PIXELS: Record<string, PixelPair> = {
  '1:1': [1024, 1024], '16:9': [1536, 864], '9:16': [864, 1536], '4:3': [1152, 864],
  '3:4': [864, 1152], '3:2': [1248, 832], '2:3': [832, 1248], '4:5': [1024, 1280],
  '5:4': [1280, 1024], '21:9': [1344, 576],
};

// GRSAI 的基础款与增强款使用不同精确尺寸，不能套用其他渠道的同名 GPT 表。
// https://qmy27nhsd9.apifox.cn/452409160e0
const GRSAI_GPT_PIXEL_STRINGS: Readonly<Record<string, readonly [string, string, string]>> = {
  '1:1': ['1024x1024', '2048x2048', '2880x2880'],
  '16:9': ['1280x720', '2048x1152', '3840x2160'],
  '9:16': ['720x1280', '1152x2048', '2160x3840'],
  '4:3': ['1152x864', '2304x1728', '3264x2448'],
  '3:4': ['864x1152', '1728x2304', '2448x3264'],
  '3:2': ['1536x1024', '2048x1360', '3504x2336'],
  '2:3': ['1024x1536', '1360x2048', '2336x3504'],
  '5:4': ['1120x896', '2240x1792', '3200x2560'],
  '4:5': ['896x1120', '1792x2240', '2560x3200'],
  '21:9': ['1456x624', '2912x1248', '3840x1648'],
  '9:21': ['624x1456', '1248x2912', '1648x3840'],
  '2:1': ['1536x768', '3072x1536', '3840x1920'],
  '1:2': ['768x1536', '1536x3072', '1920x3840'],
};
const GRSAI_GPT_BASE_PIXEL_STRINGS: Readonly<Record<string, string>> = {
  '1:1': '1024x1024', '16:9': '1672x941', '9:16': '941x1672',
  '4:3': '1443x1090', '3:4': '1090x1443', '3:2': '1536x1024',
  '2:3': '1024x1536', '5:4': '1408x1120', '4:5': '1120x1408',
  '21:9': '1920x832', '9:21': '832x1920', '1:2': '896x1792', '2:1': '1792x896',
};
function pixelStringRow(rows: Readonly<Record<string, string>>): Record<string, PixelPair> {
  return Object.fromEntries(Object.entries(rows).map(([ratio, size]) => [ratio, size.split('x').map(Number) as [number, number]]));
}

const IMAGE_SIZE_PROFILES: Record<ImageSizeProfile, ImageDimensions> = {
  'openai-gpt': GPT_DIMENSIONS,
  'apimart-gpt-2.5': APIMART_GPT_DIMENSIONS,
  'toapis-gpt-2.5': TOAPIS_GPT_DIMENSIONS,
  'google-gemini-2.5-flash': { '1K': GOOGLE_25_FLASH_PIXELS },
  'google-gemini-3-pro': googlePixelScales(GOOGLE_3_PRO_PIXELS),
  'google-nano-banana-2.1': googlePixelScales(GOOGLE_NANO_21_PIXELS),
  'relayon-image-2': imagePixelTiers({ ...RELAYON_COMMON_PIXELS,
    '9:21': [[576, 1344], [864, 2016], [1632, 3808]],
  }),
  'relayon-image-2.5': imagePixelTiers({ ...RELAYON_COMMON_PIXELS,
    '4:5': [[1024, 1280], [1600, 2048], [2304, 2880]],
    '5:4': [[1280, 1024], [2048, 1600], [2880, 2304]],
  }),
  'relayon-nano-banana': googlePixelScales(RELAYON_NANO_PIXELS),
  'relayon-seedream-5-pro': {
    '1K': { '1:1': [1024, 1024], '4:3': [1280, 960], '3:4': [960, 1280],
      '16:9': [1536, 864], '9:16': [864, 1536], '3:2': [1536, 1024] },
    '2K': { '1:1': [2048, 2048], '4:3': [2048, 1536], '3:4': [1536, 2048],
      '16:9': [2048, 1152], '9:16': [1152, 2048], '3:2': [2016, 1344] },
  },
  'relayon-midjourney': { '1K': RELAYON_MJ_PIXELS },
  'relayon-midjourney-8': { '1K': RELAYON_MJ_PIXELS,
    '2K': { '1:1': [2048, 2048], '16:9': [2048, 1152], '9:16': [1152, 2048], '4:3': [2048, 1536],
      '3:4': [1536, 2048], '3:2': [2048, 1360], '2:3': [1360, 2048], '4:5': [1632, 2040],
      '5:4': [2040, 1632], '21:9': [2016, 864] },
  },
  'grsai-gpt': Object.fromEntries(['1K', '2K', '4K'].map((resolution, index) => [resolution,
    pixelStringRow(Object.fromEntries(Object.entries(GRSAI_GPT_PIXEL_STRINGS).map(([ratio, sizes]) => [ratio, sizes[index]]))),
  ])),
  'grsai-gpt-base': { '1K': pixelStringRow(GRSAI_GPT_BASE_PIXEL_STRINGS) },
  'volcengine-seedream-5-pro': {
    '1K': { '1:1': [1024, 1024], '4:3': [1152, 864], '3:4': [864, 1152],
      '16:9': [1424, 800], '9:16': [800, 1424], '3:2': [1248, 832], '2:3': [832, 1248], '21:9': [1568, 672] },
    '1.5K': { '1:1': [1536, 1536], '4:3': [1792, 1344], '3:4': [1344, 1792],
      '16:9': [2048, 1152], '9:16': [1152, 2048], '3:2': [1872, 1248], '2:3': [1248, 1872], '21:9': [2352, 1008] },
    '2K': { '1:1': [2048, 2048], '4:3': [2368, 1776], '3:4': [1776, 2368],
      '16:9': [2816, 1584], '9:16': [1584, 2816], '3:2': [2496, 1664], '2:3': [1664, 2496], '21:9': [3136, 1344] },
  },
  'apimart-seedream-5': {
    '1K': { '1:1': [1024, 1024], '4:3': [1152, 864], '3:4': [864, 1152], '16:9': [1312, 736], '9:16': [736, 1312], '3:2': [1248, 832], '2:3': [832, 1248], '2:1': [1440, 720], '1:2': [720, 1440], '21:9': [1568, 672] },
    '1.5K': { '1:1': [1536, 1536], '4:3': [1792, 1344], '3:4': [1344, 1792], '16:9': [2048, 1152], '9:16': [1152, 2048], '3:2': [1872, 1248], '2:3': [1248, 1872], '2:1': [2176, 1088], '1:2': [1088, 2176], '21:9': [2352, 1008] },
    '2K': { '1:1': [2048, 2048], '4:3': [2304, 1728], '3:4': [1728, 2304], '16:9': [2560, 1440], '9:16': [1440, 2560], '3:2': [2496, 1664], '2:3': [1664, 2496], '2:1': [2880, 1440], '1:2': [1440, 2880], '21:9': [3024, 1296] },
  },
};

/** 返回隔离副本，用户编辑模板不能改变内置渠道尺寸。 */
export function getImageSizePresets(profile: ImageSizeProfile): ImageDimensions {
  return structuredClone(IMAGE_SIZE_PROFILES[profile]);
}

/** 显式表优先；没有表时保持已支持的短边估算。auto 结果仅供布局，实际尺寸由产物确认。 */
export function resolveImageDimensions(
  capability: ImageModelCapability | undefined,
  resolution: string | undefined,
  ratio: string,
): { width: number; height: number } {
  const adaptive = ['auto', 'adaptive', '自适应'].includes(ratio);
  if (capability?.dimensionPresets) {
    const key = Object.keys(capability.dimensionPresets).find((value) => value.toLowerCase() === resolution?.toLowerCase());
    const dimensions = key ? capability.dimensionPresets[key][ratio]
      ?? (adaptive ? capability.dimensionPresets[key]['1:1'] : undefined) : undefined;
    if (dimensions) return { width: dimensions[0], height: dimensions[1] };
    if (!adaptive) throw new Error(`图片参数 ${resolution} / ${ratio} 缺少像素尺寸映射，请重新应用模板或补齐尺寸表`);
  }
  const normalized = resolution?.trim().toLowerCase();
  const explicit = normalized?.match(/^(\d+)\s*[x×]\s*(\d+)$/);
  if (explicit && Number(explicit[1]) > 0 && Number(explicit[2]) > 0) {
    return { width: Number(explicit[1]), height: Number(explicit[2]) };
  }
  const shortSides: Record<string, number> = {
    '512': 512, '0.5k': 512, '1k': 1024, '1.5k': 1536, '2k': 2048, '3k': 3072, '4k': 4096,
    '1mp': 1024, '2mp': 1536, '3mp': 2048, '4mp': 2560, '720p': 720, '720': 720,
  };
  // 未知枚举可能只映射到协议的 imageSize；保留旧布局估计，不能因此阻止已有自定义连接。
  // 确定像素的请求合同必须提供上面的尺寸表，产物实际宽高仍以文件为准。
  const shortSide = normalized ? shortSides[normalized] ?? 1024 : 1024;
  const [widthRatio, heightRatio] = ratio.split(':').map(Number);
  if (adaptive || !widthRatio || !heightRatio) return { width: shortSide, height: shortSide };
  return widthRatio >= heightRatio
    ? { width: Math.round(shortSide * widthRatio / heightRatio), height: shortSide }
    : { width: shortSide, height: Math.round(shortSide * heightRatio / widthRatio) };
}
