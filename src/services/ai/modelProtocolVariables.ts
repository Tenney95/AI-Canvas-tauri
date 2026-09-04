/**
 * ai/modelProtocolVariables — 自定义 / 中转模型调用协议的变量总表。
 *
 * 这里是唯一来源：协议模板允许写哪些 `{{变量}}`、中转站文档里的请求字段名落到哪个变量、
 * 哪些变量属于连线带入的参考素材，全部由本表派生（modelProtocol 的变量白名单、
 * modelProtocolImport 的字段识别、modelProtocolRuntime 的参考素材覆盖检查）。
 * 三处清单从此不会各自漂移。
 *
 * 兼容一个新中转站通常只是往对应变量的 fields 里加一个字段名，不需要动任何判断分支。
 * 字段名一律写归一化形式：小写、只保留字母和数字（`image_urls` / `imageURLs` → `imageurls`）。
 */
import type { GeneralModelCategory } from '../../types';
import type { ProtocolJsonValue } from '../../types/aiTypes';

/** 需要按示例值分流、或要写成变量路径的特殊字段规则。 */
export interface ProtocolFieldRule {
  key: string;
  /** 仅这些模型类别命中；省略表示所有类别 */
  categories?: GeneralModelCategory[];
  /** 同名字段按示例值再分流（如 size 既可能是 "1024x1024" 也可能是 "16:9"） */
  when?: (value: ProtocolJsonValue) => boolean;
  /** 命中后写入的模板；省略时用 `{{变量名}}` */
  template?: string;
}

export interface ProtocolVariableSpec {
  /** 协议模板里写的变量名 */
  name: string;
  /**
   * 哪些类别的生成入口在运行时会提供这个变量。
   * 没提供就等于模板写了也拿不到值（字段会被整条省略），所以它同时决定了
   * 字段能否映射到该变量，以及模型设置里给用户列出的可用变量。
   */
  supplied: GeneralModelCategory[];
  /** 连线带入的参考素材（参考图 / 视频 / 音频），用于检查协议有没有接住参考素材 */
  reference?: boolean;
  /** 同一字段名在多个变量间还需要区分时，进一步限定类别；会落到下面每个 field 上 */
  categories?: GeneralModelCategory[];
  /** 能映射到该变量的请求字段名 */
  fields?: string[];
  /** 需要 when / template 的特殊字段 */
  rules?: ProtocolFieldRule[];
}

const TEXT: GeneralModelCategory[] = ['text'];
const VIDEO: GeneralModelCategory[] = ['video'];
const AUDIO: GeneralModelCategory[] = ['audio'];
const IMAGE: GeneralModelCategory[] = ['image'];
const IMAGE_VIDEO: GeneralModelCategory[] = ['image', 'video'];
const VIDEO_AUDIO: GeneralModelCategory[] = ['video', 'audio'];
/** 非文本类模型：这些模型的「待生成内容」字段名五花八门，但语义都是 prompt */
const MEDIA: GeneralModelCategory[] = ['image', 'video', 'audio'];
const ALL: GeneralModelCategory[] = ['text', 'image', 'video', 'audio'];

const isRatio = (value: ProtocolJsonValue) =>
  typeof value === 'string' && /^\d+\s*:\s*\d+$/.test(value);

const isResolutionPreset = (value: ProtocolJsonValue) =>
  typeof value === 'string' && /^\d+(?:\.\d+)?\s*[pk]$/i.test(value.trim());

const isNumericStringValue = (value: ProtocolJsonValue) => (
  typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
);

const isVideoInputMode = (value: ProtocolJsonValue) => (
  typeof value === 'string'
  && ['text', 'keyframe', 'reference'].includes(value.trim().toLowerCase())
);

/**
 * 参考图字段分两类：恒为数组的复数字段，和单张 / 数组两用的单数字段。
 * inferImageReferenceRequestMode 也用这两组判断请求模式，所以在此统一声明。
 */
export const IMAGE_ARRAY_FIELDS = [
  'imageurls', 'images', 'referenceimages', 'imagelist', 'imgurls', 'inputimages',
];
export const IMAGE_SINGLE_FIELDS = [
  'image', 'inputimage', 'referenceimage', 'firstframeimage',
  'imageurl', 'imgurl', 'initimage', 'sourceimage', 'baseimage',
];

export const PROTOCOL_VARIABLES: readonly ProtocolVariableSpec[] = [
  { name: 'model', supplied: ALL, fields: ['model', 'modelid', 'modelname', 'modelcode'] },
  {
    name: 'prompt', supplied: ALL,
    fields: ['prompt', 'inputprompt', 'textprompt', 'description', 'positiveprompt'],
    // TTS / 生图 / 生视频接口的待生成内容字段名常常不叫 prompt（OpenAI TTS 用 input，
    // 部分中转用 text）；不映射就会把文档示例里的样例文案当固定值发出去
    rules: MEDIA.flatMap((category) => (
      ['input', 'text'].map((key) => ({ key, categories: [category] }))
    )),
  },
  { name: 'messages', supplied: TEXT, fields: ['messages'] },
  { name: 'stream', supplied: TEXT, fields: ['stream'] },
  { name: 'tools', supplied: TEXT, fields: ['tools'] },
  { name: 'toolChoice', supplied: TEXT, fields: ['toolchoice'] },
  { name: 'size', supplied: IMAGE_VIDEO, fields: ['size'] },
  {
    name: 'aspectRatio', supplied: IMAGE_VIDEO,
    fields: ['aspectratio', 'ratio', 'aspect', 'imageratio', 'videoratio'],
    rules: [{ key: 'size', when: isRatio }],
  },
  {
    name: 'imageSize', supplied: IMAGE,
    fields: ['imagesize', 'quality'],
    rules: [
      { key: 'resolution', categories: IMAGE },
      { key: 'imageresolution', categories: IMAGE },
    ],
  },
  // 非图片模型的 resolution 走视频档位（'720p' 这类），图片模型由上面的规则先接走
  {
    name: 'seedanceResolution', supplied: VIDEO,
    fields: ['resolution', 'videoresolution', 'videoquality'],
    // 视频接口常把 720P / 2K 写在 size，而 width x height 仍走通用 size。
    rules: [{ key: 'size', categories: VIDEO, when: isResolutionPreset }],
  },
  { name: 'width', supplied: IMAGE_VIDEO, fields: ['width', 'imagewidth', 'videowidth'] },
  { name: 'height', supplied: IMAGE_VIDEO, fields: ['height', 'imageheight', 'videoheight'] },
  {
    name: 'n', supplied: MEDIA,
    fields: ['n', 'count', 'numimages', 'batchcount', 'batchsize', 'numoutputs', 'samplecount'],
  },
  { name: 'frames8n1', supplied: VIDEO, fields: ['numframes', 'frames', 'framecount'] },
  { name: 'fps', supplied: VIDEO, fields: ['framerate', 'fps'] },
  {
    name: 'duration', supplied: VIDEO_AUDIO,
    fields: ['duration', 'seconds', 'videoduration', 'durationseconds'],
    rules: [
      // 部分视频接口严格要求字符串秒数；按文档示例的 JSON 类型选择对应变量，
      // 不在传输层擅自把所有 duration 都改成字符串。
      ...['duration', 'seconds', 'videoduration', 'durationseconds'].map((key) => ({
        key,
        categories: VIDEO,
        when: isNumericStringValue,
        template: '{{durationText}}',
      })),
      // Flow Music 一类音乐接口用 length 表示时长
      { key: 'length', categories: AUDIO },
    ],
  },
  {
    name: 'generateAudio', supplied: VIDEO,
    fields: ['generateaudio', 'withaudio', 'enableaudio'],
    // MiniMax-H3 等把开关直接叫 audio，只有布尔值才是开关（否则是参考音频）
    rules: [{ key: 'audio', categories: VIDEO, when: (value) => typeof value === 'boolean' }],
  },
  { name: 'audioVoice', supplied: AUDIO, fields: ['voice', 'audiovoice', 'voiceid', 'timbre'] },
  {
    name: 'audioFormat', supplied: AUDIO,
    categories: AUDIO,
    fields: ['format', 'audioformat', 'responseformat', 'outputformat'],
  },
  { name: 'audioSpeed', supplied: AUDIO, categories: AUDIO, fields: ['speed', 'audiospeed', 'speedratio'] },
  { name: 'musicLyrics', supplied: AUDIO, categories: AUDIO, fields: ['lyrics', 'musiclyrics'] },
  { name: 'musicTitle', supplied: AUDIO, categories: AUDIO, fields: ['title', 'musictitle', 'songtitle'] },
  { name: 'musicBpm', supplied: AUDIO, categories: AUDIO, fields: ['bpm', 'musicbpm'] },

  // ── 参考素材 ──
  {
    name: 'imageWithRoles', supplied: VIDEO,
    reference: true,
    categories: VIDEO,
    // Seedance 2.x 的带角色参考图数组 [{ url, role }]，整体由运行时变量替换
    fields: ['imagewithroles', 'imageswithroles', 'imageroles'],
  },
  {
    name: 'firstImage', supplied: VIDEO,
    reference: true,
    categories: VIDEO,
    fields: ['firstimage', 'firstframeimage', 'firstframe', 'firstframeurl', 'startimage', 'startframe'],
  },
  {
    name: 'lastImage', supplied: VIDEO,
    reference: true,
    categories: VIDEO,
    fields: ['lastimage', 'lastframeimage', 'lastframe', 'lastframeurl', 'endimage', 'endframe', 'tailimage'],
  },
  {
    name: 'referenceImageUrls', supplied: VIDEO,
    reference: true,
    categories: VIDEO,
    fields: ['referenceimageurls', 'referenceimages'],
  },
  { name: 'videoUrls', supplied: VIDEO, reference: true, categories: VIDEO, fields: ['videourls', 'videos', 'inputvideos'] },
  {
    name: 'referenceVideoUrl', supplied: VIDEO,
    reference: true,
    categories: VIDEO,
    fields: ['referencevideourl', 'videourl', 'inputvideo'],
  },
  {
    name: 'referenceVideoUrls', supplied: VIDEO,
    reference: true,
    categories: VIDEO,
    fields: ['referencevideourls', 'referencevideos'],
  },
  { name: 'audioUrls', supplied: VIDEO_AUDIO, reference: true, categories: VIDEO_AUDIO, fields: ['audiourls', 'audios'] },
  { name: 'audioUrl', supplied: VIDEO_AUDIO, reference: true, categories: VIDEO_AUDIO, fields: ['audiourl', 'inputaudio'] },
  {
    name: 'referenceAudioUrls', supplied: VIDEO_AUDIO,
    reference: true,
    fields: ['referenceaudios', 'referenceaudiourls'],
  },
  {
    name: 'imageUrls', supplied: IMAGE_VIDEO,
    reference: true,
    fields: IMAGE_ARRAY_FIELDS,
    // 单数字段给了数组就整体替换，给了单值就只取第一张
    rules: IMAGE_SINGLE_FIELDS.flatMap((key) => [
      { key, when: Array.isArray },
      { key, template: '{{imageUrls.0}}' },
    ]),
  },
  {
    name: 'referenceUrls', supplied: VIDEO,
    reference: true,
    categories: VIDEO,
    fields: ['referenceurls'],
  },
  {
    name: 'inlineReferences', supplied: VIDEO,
    reference: true,
    categories: VIDEO,
    fields: ['references', 'inlinereferences'],
  },

  // 运行时提供但没有对应请求字段名的别名变量，仍允许模板直接引用
  { name: 'batchCount', supplied: MEDIA },
  { name: 'frames', supplied: VIDEO },
  { name: 'resolution', supplied: VIDEO },
  { name: 'videoResolution', supplied: VIDEO },
  { name: 'videoFrames', supplied: VIDEO },
  { name: 'videoFps', supplied: VIDEO },
  { name: 'seedanceRatio', supplied: VIDEO },
  { name: 'seedanceDuration', supplied: VIDEO },
  { name: 'videoOperation', supplied: VIDEO },
  {
    name: 'videoInputMode', supplied: VIDEO,
    // Agnes 2.5 等接口用 mode 在 text / keyframe / reference 三种互斥输入形态间切换。
    // 只有示例值明确属于这三个枚举时才映射，避免误把其他厂商的通用 mode 字段改写。
    rules: [{ key: 'mode', categories: VIDEO, when: isVideoInputMode }],
  },
  { name: 'durationText', supplied: VIDEO },
  { name: 'disableAudio', supplied: VIDEO },
];

/**
 * 设置页中变量标签的悬浮说明。说明描述运行时真正注入的值，避免用户按接口字段名猜语义。
 * 新增协议变量时，定向测试会要求同步补充这里的说明。
 */
const PROTOCOL_VARIABLE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  model: '实际请求使用的模型 ID',
  prompt: '节点中的提示词（已解析文本引用）',
  messages: '发送给对话模型的消息数组',
  stream: '是否启用流式响应',
  tools: '当前可供对话模型调用的工具定义数组',
  toolChoice: '对话模型的工具选择策略',
  size: '输出宽高尺寸字符串，如 1280x720',
  aspectRatio: '输出宽高比，如 16:9',
  imageSize: '图片分辨率或质量档位，如 2K',
  seedanceResolution: '视频分辨率档位，如 720p',
  width: '输出宽度（像素）',
  height: '输出高度（像素）',
  n: '本次请求生成的结果数量',
  frames8n1: '按 8 × n + 1 规则对齐后的视频帧数',
  fps: '视频帧率（每秒帧数）',
  duration: '视频或音频时长（秒，数值）',
  generateAudio: '是否让视频模型同时生成音频',
  audioVoice: '语音模型使用的音色或声音 ID',
  audioFormat: '音频输出格式，如 mp3 或 wav',
  audioSpeed: '语音播放速度倍率',
  musicLyrics: '音乐生成使用的歌词文本',
  musicTitle: '音乐生成使用的歌曲标题',
  musicBpm: '音乐速度（每分钟节拍数）',
  imageWithRoles: '带角色的参考图数组，元素包含 url 和 role',
  firstImage: '视频首帧图片 URL',
  lastImage: '视频尾帧图片 URL',
  referenceImageUrls: '普通参考图 URL 数组（不含首尾帧）',
  videoUrls: '输入视频 URL 数组',
  referenceVideoUrl: '第一条参考视频 URL',
  referenceVideoUrls: '参考视频 URL 数组',
  audioUrls: '输入音频 URL 数组',
  audioUrl: '第一条输入音频 URL',
  referenceAudioUrls: '参考音频 URL 数组',
  imageUrls: '输入或参考图片 URL 数组',
  referenceUrls: '所有 HTTP(S) 参考素材 URL 数组',
  inlineReferences: '所有 data: 内联参考素材数组',
  batchCount: '批量生成数量，与 n 的值相同',
  frames: '视频总帧数',
  resolution: '视频分辨率档位，如 720p',
  videoResolution: '由宽高计算的视频长边像素值',
  videoFrames: '视频总帧数，与 frames 的值相同',
  videoFps: '视频帧率，与 fps 的值相同',
  seedanceRatio: '视频宽高比，与 aspectRatio 的值相同',
  seedanceDuration: '视频时长（秒），与 duration 的值相同',
  videoOperation: '视频任务类型，如文生视频或图生视频',
  videoInputMode: '视频输入模式：text、keyframe 或 reference',
  durationText: '字符串形式的视频时长（秒）',
  disableAudio: '是否明确要求视频静音；静音时为 true',
};

export function getProtocolVariableDescription(name: string): string | undefined {
  return PROTOCOL_VARIABLE_DESCRIPTIONS[name];
}

interface CompiledRule extends ProtocolFieldRule {
  template: string;
  /** 该变量在哪些类别下真的有值 */
  supplied: GeneralModelCategory[];
  /** 越具体越先匹配：限定类别 > 限定取值 > 通用 */
  score: number;
}

const COMPILED_RULES: CompiledRule[] = PROTOCOL_VARIABLES
  .flatMap((spec) => {
    const plain: ProtocolFieldRule[] = (spec.fields ?? [])
      .map((key) => ({ key, categories: spec.categories }));
    const special = (spec.rules ?? []).map((rule) => ({
      ...rule,
      categories: rule.categories ?? spec.categories,
    }));
    return [...plain, ...special].map((rule) => ({
      ...rule,
      supplied: spec.supplied,
      template: rule.template ?? `{{${spec.name}}}`,
      score: (rule.categories ? 2 : 0) + (rule.when ? 1 : 0),
    }));
  })
  .sort((left, right) => right.score - left.score);

/** 协议模板允许引用的变量名，供 modelProtocol 校验。 */
export const PROTOCOL_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  PROTOCOL_VARIABLES.map((spec) => spec.name),
);

/** 连线带入的参考素材变量；协议一个都没引用就说明参考素材接不住。 */
export const REFERENCE_PROTOCOL_VARIABLES: readonly string[] = PROTOCOL_VARIABLES
  .filter((spec) => spec.reference)
  .map((spec) => spec.name);

/**
 * 把中转站请求体里的一个字段名解析成协议模板值（如 `{{imageUrls}}`）。
 * 认不出来返回 undefined，调用方保留字面量。
 *
 * 该类别运行时拿不到值的变量不参与匹配：映射过去只会让这个字段在真实请求里
 * 整条消失（如给文本模型的 input 映射成 prompt），保留字面量才是对的。
 */
export function resolveProtocolFieldTemplate(
  normalizedField: string,
  value: ProtocolJsonValue,
  category: GeneralModelCategory,
): string | undefined {
  return COMPILED_RULES.find((rule) => (
    rule.key === normalizedField
    && rule.supplied.includes(category)
    && (!rule.categories || rule.categories.includes(category))
    && (!rule.when || rule.when(value))
  ))?.template;
}

/** 该类别的模型在协议模板里能引用的变量，供模型设置里的「可用变量」列表使用。 */
export function getCategoryProtocolVariables(category: GeneralModelCategory): string[] {
  return PROTOCOL_VARIABLES
    .filter((spec) => spec.supplied.includes(category))
    .map((spec) => spec.name);
}
