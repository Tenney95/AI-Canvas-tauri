/**
 * Slash Commands — 预设提示词指令数据
 * 根据 nodeType 返回对应的指令菜单树
 */
import type { ImagePostProcess, NodeType } from '../../../types';
import { DRAMA_EXTRACT_MARKER } from '../../../types/dramaAssets';

export interface SlashCommandItem {
  id: string;
  title: string;
  icon: string;     // iconify icon name (e.g. 'mdi:cube-outline') or emoji
  description: string;
  promptTemplate?: string;
  children?: SlashCommandItem[];
  /** 可选：预设画质，选择后覆盖节点设置 */
  imageSize?: string;
  /** 可选：预设宽高比，选择后覆盖节点设置 */
  aspectRatio?: string;
  /** 可选：仅作用于本次生成的图像后处理 */
  postProcess?: ImagePostProcess;
}

// ── 图片预设提示词 ──

const IMAGE_COMMANDS: SlashCommandItem[] = [
  {
    id: 'scene',
    title: '场景参考',
    icon: 'mdi:cube-outline',
    description: '一键生成场景多视图和全景图',
    children: [
      {
        id: 'scene-four-view',
        title: '场景四视图',
        icon: 'mdi:view-grid-outline',
        description: '一键生成场景多视图',
        promptTemplate: '生成一张四宫格场景图（没有人物）包含（顶视图 (Plan View)，轴测图/45° 俯视图 (Axonometric View)，2个多个正交立面图 (Elevations)）\n{{ 文章内容 }}',
      },
      {
        id: 'scene-panorama',
        title: '360°无缝全景图',
        icon: 'mdi:panorama',
        description: '生成适合 VR 查看的一张无缝 360° 全景图',
        promptTemplate: '360-degree equirectangular panorama, spherical panorama for VR viewing, seamless 360° wrap-around environment 场景为：\n{{ 文章内容 }}',
      },
    ],
  },
  {
    id: 'character',
    title: '人设参考',
    icon: 'mdi:account',
    description: '一键生成人物多视图 三视图、三视图加脸部、人设拆解图',
    children: [
      {
        id: 'char-three-view',
        title: '人物三视图',
        icon: 'mdi:account-multiple',
        description: '纯正的三向视图展示',
        promptTemplate: '生成全身三视图，右边放正视图，45度的侧视图，后视图，\n{{ 文章内容 }}',
      },
      {
        id: 'char-three-view-face',
        title: '人物三视图+脸部',
        icon: 'mdi:face-man',
        description: '带脸部特写的三视图',
        promptTemplate: '生成全身三视图以及一张脸部特写（最左边占满三分之一的位置是上半身特写），右边三分之二放正视图，45度的侧视图，后视图，\n{{ 文章内容 }}',
      },
      {
        id: 'char-design-sheet',
        title: '人设解析图',
        icon: 'mdi:file-account-outline',
        description: '包含细节拆解的设定集',
        promptTemplate: '生成人设解析图，包含正视图、侧视图、背视图，以及服装细节拆解、面部特征特写，排版紧凑，\n{{ 文章内容 }}',
      },
      {
        id: 'char-8dir-run',
        title: '角色8向图-奔跑',
        icon: 'mdi:compass',
        description: '8方向角色朝向图，奔跑动作 · 9:16 2K',
        promptTemplate: 'generate five variants in the blank grid spaces. The arrows represent the character\'s facing direction.\nconstraint: 角色奔跑动作，迈开双腿，一前一后\nLayout: {\n   "Row 1": ["Reference image, keep unchanged", "Right side view, facing right"],\n   "Row 2 (Flat view)": ["Absolute front view", "Back view"],\n   "Row 3 (Isometric 45° view)": ["Facing bottom-right, face visible", "Facing top-left, face not visible"]\n   }\n   All character features (appearance, accessories, weapons, pose, etc.) must remain consistent; only the orientation should change. Delete arrows after generation. green background. The image should contain no text. \n{{ 文章内容 }}',
        imageSize: '2K',
        aspectRatio: '9:16',
        postProcess: 'character-8-direction-grid',
      },
      {
        id: 'char-8dir-walk',
        title: '角色8向图-行走',
        icon: 'mdi:compass-outline',
        description: '8方向角色朝向图，行走动作 · 9:16 2K',
        promptTemplate: 'generate five variants in the blank grid spaces. The arrows represent the character\'s facing direction.\nconstraint: 角色行走动作\nLayout: {\n   "Row 1": ["Reference image, keep unchanged", "Right side view, facing right"],\n   "Row 2 (Flat view)": ["Absolute front view", "Back view"],\n   "Row 3 (Isometric 45° view)": ["Facing bottom-right, face visible", "Facing top-left, face not visible"]\n   }\n   All character features (appearance, accessories, weapons, pose, etc.) must remain consistent; only the orientation should change. Delete arrows after generation. green background. The image should contain no text. \n{{ 文章内容 }}',
        imageSize: '2K',
        aspectRatio: '9:16',
        postProcess: 'character-8-direction-grid',
      },
    ],
  },
  {
    id: 'grid',
    title: '多宫格',
    icon: 'mdi:view-grid-outline',
    description: '一键生成剧情连续的多宫格图片',
    children: [
      {
        id: 'grid-4',
        title: '4宫格',
        icon: 'icon-park-outline:grid-four',
        description: '起承转合更清晰，适合一句话剧情',
        promptTemplate: '生成一张无缝的四宫格（2x2）的连贯剧情分镜图。要求：同一角色的外观、服饰、发型保持一致；场景与光影风格统一；镜头从左上到右下依次推进；每一格都有明确动作与主体，构图干净、排版紧凑。故事/描述：\n{{ 文章内容 }}',
      },
      {
        id: 'grid-9',
        title: '9宫格',
        icon: 'icon-park-outline:grid-nine',
        description: '3x3 更细动作与情绪递进',
        promptTemplate: '生成一张无缝的九宫格（3x3）的连贯剧情分镜图。要求：角色一致性极强（外观、服饰、配色不变）；同一场景基调延续；每格推进一个小动作或情绪变化；分镜顺序从左上到右下；画面干净、排版紧凑。故事/描述：\n{{ 文章内容 }}',
      },
      {
        id: 'grid-16',
        title: '16宫格',
        icon: 'icon-park-outline:grid-sixteen',
        description: '4x4 更密的节奏推进与镜头切换',
        promptTemplate: '生成一张无缝的十六宫格（4x4）的连贯剧情分镜图。要求：角色一致性极强（外观、服饰、配色不变）；同一场景基调延续；每格推进一个小动作或情绪变化；分镜顺序从左上到右下；画面干净、排版紧凑。故事/描述：\n{{ 文章内容 }}',
      },
      {
        id: 'grid-25',
        title: '25宫格',
        icon: 'icon-park-outline:grid-sixteen',
        description: '5x5 长连续剧情，适合完整片段',
        promptTemplate: '生成一张无缝的二十五宫格（5x5）的连贯剧情分镜图。要求：角色一致性极强（外观、服饰、配色不变）；同一场景基调延续；每格推进一个小动作或情绪变化；分镜顺序从左上到右下；画面干净、排版紧凑。故事/描述：\n{{ 文章内容 }}',
      },
    ],
  },
  {
    id: 'storyboard',
    title: '故事板分镜',
    icon: 'mdi:filmstrip',
    description: '一键生成故事板分镜',
    children: [
      {
        id: 'sb-vertical',
        title: '竖版故事分镜',
        icon: 'mdi:filmstrip',
        description: '竖版分镜，从上到下推进',
        promptTemplate: `请根据我后面提供的【用户输入】，生成一张"专业影视分镜设定板 / Storyboard Board"。

要求：
1. 输出的是一整张竖版分镜板，不是单张插画，不是漫画页，不是海报。
2. 整体风格为：黑灰底、细线分栏、专业影视项目提案风格。
3. 参考图规则：如果用户输入中写了"某角色参考@图片1 / 场景参考@图片2"，则必须严格参考对应图片，保持角色外观、服装、发型、年龄气质、场景结构、时代背景、光影氛围的一致性。
4. 整张图固定分为三部分：
   - 顶部标题区：标题、总时长、风格关键词
   - 中部 Storyboard 区：按用户输入中的时间段拆成 4-6 个 CUT，每行分为左中右三栏：
     左栏：CUT编号 + 时间段
     中栏：该镜头对应的电影感画面
     右栏：主体 / 动作 / 描述 / 镜头 / 台词 / 音效
5. 分镜画面必须叙事连贯、角色一致、场景一致、服装一致、光影一致。
6. 所有中间画面都要像电影剧照，镜头语言明确，严格体现用户输入中的动作、表情、氛围和情绪推进。
7. 右侧说明栏必须用简洁专业的中文排版，字段固定为：
   主体：
   动作：
   描述：
   镜头：
   台词：
   音效：
8. 文字尽量清晰可读，不要乱码，排版整洁克制，高级感强。
9. 最终输出只生成一张完整的、专业的、电影级影视分镜设定板。

# 【用户输入】
{{ 文章内容 }}`,
      },
      {
        id: 'sb-vertical-scene',
        title: '竖版故事分镜+场景',
        icon: 'mdi:filmstrip',
        description: '竖版分镜，包含场景设定参考',
        promptTemplate: `请根据我后面提供的【用户输入】，生成一张"专业影视分镜设定板 / Storyboard Board"。

要求：
1. 输出的是一整张竖版分镜板，不是单张插画，不是漫画页，不是海报。
2. 整体风格为：黑灰底、细线分栏、专业影视项目提案风格。
3. 参考图规则：如果用户输入中写了"某角色参考@图片1 / 场景参考@图片2"，则必须严格参考对应图片，保持角色外观、服装、发型、年龄气质、场景结构、时代背景、光影氛围的一致性。
4. 整张图固定分为三部分：
   - 顶部标题区：标题、总时长、风格关键词
   - 中部 Storyboard 区：按用户输入中的时间段拆成 4-6 个 CUT，每行分为左中右三栏：
     左栏：CUT编号 + 时间段
     中栏：该镜头对应的电影感画面
     右栏：主体 / 动作 / 描述 / 镜头 / 台词 / 音效
   - 底部补充区：场景图 Secondary（2张小图）+ 光影与氛围 Lighting & Mood（1张小图）+ 色彩板与风格说明（5-6个色块）
5. 分镜画面必须叙事连贯、角色一致、场景一致、服装一致、光影一致。
6. 所有中间画面都要像电影剧照，镜头语言明确，严格体现用户输入中的动作、表情、氛围和情绪推进。
7. 右侧说明栏必须用简洁专业的中文排版，字段固定为：
   主体：
   动作：
   描述：
   镜头：
   台词：
   音效：
8. 文字尽量清晰可读，不要乱码，排版整洁克制，高级感强。
9. 最终输出只生成一张完整的、专业的、电影级影视分镜设定板。

# 【用户输入】
{{ 文章内容 }}`,
      },
      {
        id: 'sb-horizontal',
        title: '横版故事分镜',
        icon: 'mdi:filmstrip',
        description: '横版分镜，从左到右推进',
        promptTemplate: `请根据我后面提供的【用户输入】，生成一张"横版专业影视故事板 / Storyboard Sheet"。  
要求： 
1. 输出必须是一整张横版16:9故事板表格，不是海报，不是漫画页，不是竖版分镜板。 
2. 主体必须是"表格结构"，每一行对应一个 CUT。 
3. 表头固定为： CUT｜秒数｜图片内容｜场景｜主体｜动作｜描述｜镜头｜台词｜音效｜色彩/光影 
4. 按用户输入中的时间顺序，从上到下排列所有 CUT。 
5. "图片内容"列中，每个 CUT 必须对应一张横向16:9的电影感分镜画面，真实人物质感，镜头语言明确。 
6. "场景"列用于写该镜头的环境与空间信息。 
7. "色彩/光影"列用于写该镜头的色调、光源、冷暖关系与氛围重点。 
8. 其余列分别填写该镜头的主体、动作、描述、镜头、台词、音效，文字风格必须像正规影视故事板备注，简洁、专业、整齐。 
9. 如果用户输入中有"角色参考@图片1 / 场景参考@图片2 / 道具参考@图片3"，必须严格参考并保持角色、服装、场景、氛围一致。 
10. 整体风格为黑灰底、细线分栏、专业影视提案风格。 
11. 最终只输出一张完整的横版故事板表格图。  
#【用户输入】
{{ 文章内容 }}`,
      },
      {
        id: 'sb-horizontal-scene',
        title: '横版故事分镜+场景',
        icon: 'mdi:filmstrip',
        description: '横版分镜，包含场景设定参考',
        promptTemplate: `请根据我后面提供的【用户输入】，生成一张"横版专业影视故事板 / Storyboard Sheet"。  
要求： 
1. 输出必须是一整张横版16:9故事板表格，不是海报，不是漫画页，不是竖版分镜板。 
2. 主体必须是"表格结构"，每一行对应一个 CUT。 
3. 表头固定为： CUT｜秒数｜图片内容｜场景｜主体｜动作｜描述｜镜头｜台词｜音效｜色彩/光影 
4. 按用户输入中的时间顺序，从上到下排列所有 CUT。 
5. "图片内容"列中，每个 CUT 必须对应一张横向16:9的电影感分镜画面，真实人物质感，镜头语言明确。 
6. "场景"列用于写该镜头的环境与空间信息。 
7. "色彩/光影"列用于写该镜头的色调、光源、冷暖关系与氛围重点。 
8. 其余列分别填写该镜头的主体、动作、描述、镜头、台词、音效，文字风格必须像正规影视故事板备注，简洁、专业、整齐。 
9. 如果用户输入中有"角色参考@图片1 / 场景参考@图片2 / 道具参考@图片3"，必须严格参考并保持角色、服装、场景、氛围一致。 
10. 整体风格为黑灰底、细线分栏、专业影视提案风格。 
11. 表格底部增加一条补充信息区，包含：场景总设定、综合色彩色板、整体风格说明。 
12. 最终只输出一张完整的横版故事板表格图。  
#【用户输入】
{{ 文章内容 }}`,
      },
    ],
  },
];

// ── 文本预设提示词 ──

const TEXT_COMMANDS: SlashCommandItem[] = [
  {
    id: 'text-compress',
    title: '长篇精缩V1',
    icon: 'mdi:text-short',
    description: '一键把长篇内容精缩成短篇',
    promptTemplate: `# 对以上的小说剧情文案进行大幅精简（目标篇幅约为原文的50%-70%
完整保留原文对话，同时按照"对白驱动剧情"的结构重新梳理旁白与独白，保留原文段落结构与标点符号。
用第一人称进行改文
锁定所有对话： 识别并保护所有直接引语，确保一字不改。

构建开篇（10%）： 提炼原文关键背景（时代、世界观、人物身份），用简短叙事交代框架。
精简叙事（20%）： 大幅删减环境描写和过度修饰，仅保留连接对话必要的动作和场景推进。

筛选独白（30%）： 保留能强化冲突、体现人物压力和真实状态的核心心理描写，删去流水账式的心理活动。
格式输出： 保持小说文本格式，保留标点符号，保留原段落分行（必要时可合并过碎的描述段落，但不可合并对话段落）。
# 结构与内容规则
## 【整体篇幅控制】
总字数目标： 控制在原文的 50-70% 左右。
精简策略： 由于对话不能动，主要通过大幅删减"非对话部分的废话"来达成字数减半的目标。
## 【文本结构比例】
对白（核心）： 占比最高。严格保持原文，不得增删改一字。
内心独白（约30%）： 紧贴对话，用于强化情绪、痛感、压迫或绝望。
叙事（约20%）： 仅作铺垫和连接，禁止写成分镜（如"镜头一转"），禁止扩写。
背景（约10%）： 开篇必须交代，不可省略。
##【写作形式与风格】
输出格式： 纯正的小说文本，保留标点符号，保留段落感。
风格要求： 对白驱动剧情。通过精简旁白，让对话节奏更紧凑，冲突更集中。
## 禁止项：
❌ 禁止出现分镜词（特写、远景、淡入淡出）。
❌ 禁止出现时间轴（0-5秒）。
❌ 禁止删除或修改任何一句对话。
❌ 禁止新增原文没有的情节或设定。
## 情绪与逻辑
逻辑： 尽管大幅删减了旁白，必须确保对话与动作的衔接流畅，事件顺序严格遵照原文。
氛围： 突出原文中的冲突与张力，保留关键的情绪转折点。
## 输出要求
直接输出修改后的完整文案。
保留标点符号和段落格式。

{{ 文章内容 }}`,
  },
  // 三类提取与「提取人物」同级：顶级入口 + 直接触发，成功后写入短剧资产库
  {
    id: 'text-extract-characters',
    title: '提取人物',
    icon: 'mdi:account-search',
    description: '只提取人物简介表，入库后可 @ 引用（一套默认造型，无状态变体）',
    promptTemplate: `${DRAMA_EXTRACT_MARKER.character}
你是剧本资产分析助手。请阅读下列剧本，**仅提取人物**，输出 JSON（不要 Markdown 说明、不要生图提示词）。

# 规则
1. 只输出一个 JSON 对象，kind 必须为 "character"。
2. 每条人物只要**一套默认主造型**；禁止「流泪/受伤/年轻时」等状态变体。
3. 禁止输出：三视图、白底设定集、8K、镜头运镜、分镜、对白原文大段。
4. visualNotes 用短关键词描述外形要点；wardrobeDefault 为一套默认服装简述。
5. 同名角色合并，别名写入 aliases。
6. importance 只能是 main | supporting | minor。

# JSON 形状
{
  "kind": "character",
  "items": [
    {
      "name": "角色名或称呼",
      "aliases": ["别名"],
      "identity": "身份职业",
      "ageBand": "年龄段",
      "gender": "性别呈现",
      "summary": "一句话简介",
      "visualNotes": "外形要点关键词",
      "wardrobeDefault": "默认造型简述",
      "personality": "性格要点",
      "storyRole": "剧情功能",
      "importance": "main",
      "firstSeen": "首次出现场次/段落",
      "appearances": ["出场简述"],
      "relationships": [{ "targetName": "他人", "relation": "关系" }]
    }
  ],
  "notes": "可选：遗漏风险说明"
}

# 剧本正文
{{ 文章内容 }}`,
  },
  {
    id: 'text-extract-scenes',
    title: '提取场景',
    icon: 'mdi:map-search-outline',
    description: '只提取场景简介表，入库后可 @ 引用（空间与氛围，非空镜长 prompt）',
    promptTemplate: `${DRAMA_EXTRACT_MARKER.scene}
你是剧本资产分析助手。请阅读下列剧本，**仅提取场景**，输出 JSON（不要 Markdown 说明、不要生图提示词）。

# 规则
1. 只输出一个 JSON 对象，kind 必须为 "scene"。
2. 合并同一地点不同叫法；按时段/氛围可拆条（如「电影院-夜」）。
3. 禁止输出：完整空镜生图长文、运镜指令、8K、杰作等。
4. 不要展开人物外貌；人物只可在 storyRole/appearances 中点到为止。
5. importance 只能是 main | supporting | minor。

# JSON 形状
{
  "kind": "scene",
  "items": [
    {
      "name": "场景名",
      "placeType": "室内/室外/…",
      "timeOfDay": "日/夜/黄昏…",
      "summary": "一句话简介",
      "visualNotes": "视觉要点关键词",
      "spatialNotes": "空间结构简述",
      "atmosphere": "氛围",
      "storyRole": "剧情功能",
      "importance": "main",
      "firstSeen": "首次出现",
      "appearances": ["相关情节简述"]
    }
  ],
  "notes": "可选"
}

# 剧本正文
{{ 文章内容 }}`,
  },
  {
    id: 'text-extract-props',
    title: '提取道具',
    icon: 'mdi:treasure-chest',
    description: '只提取关键道具简介，入库后可 @ 引用（宁缺毋滥）',
    promptTemplate: `${DRAMA_EXTRACT_MARKER.prop}
你是剧本资产分析助手。请阅读下列剧本，**仅提取关键道具**，输出 JSON（不要 Markdown 说明、不要生图提示词）。

# 规则
1. 只输出一个 JSON 对象，kind 必须为 "prop"。
2. 只列**反复出场或推动情节**的道具；不要罗列所有桌椅杯盏。
3. 禁止输出完整静物摄影长 prompt、8K、三视图指令。
4. importance 只能是 main | supporting | minor。

# JSON 形状
{
  "kind": "prop",
  "items": [
    {
      "name": "道具名",
      "ownerName": "归属角色",
      "category": "分类",
      "summary": "一句话简介",
      "visualNotes": "外观要点",
      "significance": "为何重要",
      "storyRole": "剧情功能",
      "importance": "supporting",
      "firstSeen": "首次出现",
      "appearances": ["出场简述"]
    }
  ],
  "notes": "可选"
}

# 剧本正文
{{ 文章内容 }}`,
  },
  {
    id: 'text-extract-legacy',
    title: '提取人物场景道具（旧版混排）',
    icon: 'mdi:text-search',
    description: '旧版：一次混排人设/场景/道具（含状态，效果一般，不推荐）',
    promptTemplate: `{{ 文章内容 }}
# 筛选出以上故事里的角色（包括主要怪物）、场景以及道具物品
把以上每个角色根据剧情写出详细中文提示词包括五官相貌，脸型，发型，全身服饰提示词。重要物品，场景
用 --- 符号来分割每一个角色,先把人设输出完毕，最后再输出场景，如有角色不同状态也需要标注出来(但不需要太详细)，不用输出多余说明，不带有格式
# 输出示例：

#人设
1. 主角：沈仪
# 中文提示词：
1个青年男性，古风，捕快，英俊硬朗，剑眉星目，黑色长发，凌乱发髻，身穿古代黑色官差制服，衣衫不整，暗黑武侠，电影光效。
# 中文提示词(受伤状态)：
.....

---

2. 配角：刘家丫头
...
...
...

---
# 重要物品
1. 腰间佩戴的一把制式长刀（佩刀），刀柄古旧；
2. 。。。。
# 场景：
1. 昏暗的破旧土屋或夜晚的院落，月光惨白，暗黑压抑氛围。
2. ....`,
  },
  {
    id: 'text-format',
    title: '格式化短剧提示词',
    icon: 'mdi:format-text',
    description: '将小说一键转化为标准AI视频提示词脚本',
    children: [
      {
        id: 'text-storyboard',
        title: '影视级叙事分镜脚本',
        icon: 'mdi:clapperboard',
        description: '将小说一键转化为标准戏剧化脚本，专为AI短剧视频量身定制',
        promptTemplate: `## 核心任务
你是一个专业的AI分镜脚本生成器。任务是基于提供的文本信息，生成"视频提示词"的分镜脚本，分割后的上下分镜必须十分丝滑的连贯。

# 输入信息

**故事情节：**
{{ 文章内容 }}

# 视频提示词原则

## 视觉关键词密集度

- 规则：为最大化 AI 模型对画面的控制力，必须使用大量具体的、高辨识度的视觉描述词汇
- 场景、角色、光影、特效必须混合使用（例如："幽蓝色的霓虹线路"、"血红色的赛博月亮"、"凌厉的金色电光"、"数码化的爆炸效果"）。

## 运镜的专业化和指令化

- 规则：采用专业电影术语而非简单描述，以明确规定画面的动态行为。
- 严格使用【超广角】、【特写】等**景别**，以及【慢速推轨】、【环绕慢摇】、【动态手持】等**镜头运动**指令。

## 动作的分解与强调

- 逻辑：复杂的动作不能一笔带过，必须分解成关键帧和关键特写，确保动作的冲击力。
- 使用【爆发式跃出】（远景）接【腰部极限扭转】（近景），再接【接触的瞬间】（慢动作特写），突出高速和高冲击。

## 人物台词
- 原文中的对话内容不允许进行擅自删改。要把输入文案作为唯一的信息来源，忠实地将其内容转化为分镜脚本，避免添加任何文案中未提及的情节、动作、场景或角色心理活动。
- 对话要用""标示出来。

## 时长与节奏的控制：

- 为每个分镜设定一个合理的时长，以控制最终视频的节奏感。短时间用于高冲击特写，长时间用于场景铺垫或关键动作。
- 提示词应用的视频时长15秒及以内，剧本包含画面，运镜，所以每一幕的提示词不能超过该时间

## 听觉元素

- 在关键动作后备注音效提示，如"尖锐的破空声与低沉的能量轰鸣"或"无台词，只有金属、能量、符文破碎的声音"。

# 输出格式严格遵循的规则：
1. 保持连续性：为保证场景一致性，若前后剧情为统一场景则需要延续上一则剧本的场景
2. 剧情不能改变：保留剧情上的所有对话。
3. 设定角色、场景映射：但凡该幕出场的所有角色都应该有角色映射（[人名]参考@图片参考@音频）
4. 输出格式：按顺序输出分镜描述，不需要解释或分析过程。输出的内容应当没字体样式。

# 固定的模板格式
    - 使用 ---  作为每一幕提示词的分隔符。
    - 提示词第一部分：最顶部固定是（第X幕）无字幕，无BGM
    - 第二部分为内容（每一幕都用动作来收尾，为了更好的衔接视频上下文）。
    - 场景基调要固定好！为了更好的衔接上下镜头（如：秋季，大风，漆黑的夜晚）。`,
      },
      {
        id: 'text-storyboard-seconds',
        title: '影视级叙事分镜脚本-秒级',
        icon: 'mdi:timer-outline',
        description: '精确到秒的光影渲染、运镜与音效控制，专为AI短剧视频量身定制',
        promptTemplate: `## 核心任务
你是一个专业的AI分镜脚本生成器。任务是基于提供的文本信息，生成"视频提示词"的分镜脚本，分割后的上下分镜必须十分丝滑的连贯。
# 输入信息

**故事情节：**
{{ 文章内容 }}

# 视频提示词原则

## 视觉关键词密集度
- 规则：为最大化 AI 模型对画面的控制力，必须使用大量具体的、高辨识度的视觉描述词汇
- 场景、角色、光影、特效必须混合使用（例如："幽蓝色的霓虹线路"、"血红色的赛博月亮"、"凌厉的金色电光"、"数码化的爆炸效果"）。

## 运镜的专业化和指令化
- 规则：采用专业电影术语而非简单描述，以明确规定画面的动态行为。
- 严格使用【超广角】、【特写】等**景别**，以及【慢速推轨】、【环绕慢摇】、【动态手持】等**镜头运动**指令。

## 动作的分解与强调
- 逻辑：复杂的动作不能一笔带过，必须分解成关键帧和关键特写，确保动作的冲击力。
- 使用【爆发式跃出】（远景）接【腰部极限扭转】（近景），再接【接触的瞬间】（慢动作特写），突出高速和高冲击。

## 人物台词
- 原文中的对话内容不允许进行擅自删改。要把输入文案作为唯一的信息来源，忠实地将其内容转化为分镜脚本，避免添加任何文案中未提及的情节、动作、场景或角色心理活动。
- 对话要用""标示出来。

## 时长与节奏的控制：
- 为每个分镜设定一个合理的时长，以控制最终视频的节奏感。短时间用于高冲击特写，长时间用于场景铺垫或关键动作。
- 提示词应用的视频时长15秒及以内，剧本包含画面，运镜，所以每一幕的提示词不能超过该时间

## 听觉元素
- 在关键动作后备注音效提示，如"尖锐的破空声与低沉的能量轰鸣"或"无台词，只有金属、能量、符文破碎的声音"。

# 输出格式严格遵循的规则：
1. 保持连续性：为保证场景一致性，若前后剧情为统一场景则需要延续上一则剧本的场景
2. 剧情不能改变：保留剧情上的所有对话。
3. 设定角色、场景映射：但凡该幕出场的所有角色都应该有角色映射（[人名]参考@图片参考@音频）
4. 输出格式：按顺序输出分镜描述，不需要解释或分析过程。输出给我的内容应当没字体样式。

# 固定的模板格式
    - 使用 ---  作为每一幕提示词的分隔符。
    - 提示词第一部分：最顶部固定是（第X幕）无字幕，无BGM
    - 第二部分为内容（可以的话每一幕都用动作来收尾，为了更好的衔接视频上下文）。
    - 场景基调要固定好！为了更好的衔接上下镜头（如：秋季，大风，漆黑的夜晚）。`,
      },
      {
        id: 'text-seedance',
        title: 'Seedance2.0视频格式',
        icon: 'mdi:video-outline',
        description: '按用户秒数或默认15秒输出 Seedance 2.0 秒级视频提示词',
        promptTemplate: `{{ 文章内容 }}
如用户指定秒数就按照用户的来，如没指定就按照15秒来写提示词，不要输出多余内容。严格按照下面格式输出提示词
x-xs：景别，行为
x-xs：景别，行为
x-xs：景别，行为`,
      },
    ],
  },
];

// ── API ──

export function getSlashCommands(nodeType: NodeType): SlashCommandItem[] {
  switch (nodeType) {
    case 'ai-image':
      return IMAGE_COMMANDS;
    case 'ai-text':
      return TEXT_COMMANDS;
    default:
      return [];
  }
}

/**
 * 将当前提示词填入模板的 {{ 文章内容 }} 占位符
 * 如果模板不含该占位符，则将输入内容拼接到模板最上方
 */
export function fillTemplate(template: string, currentPrompt: string): string {
  const placeholder = '{{ 文章内容 }}';
  if (template.includes(placeholder)) {
    return template.replace(placeholder, currentPrompt || '');
  }
  // 无占位符时，把用户输入放到最上方
  return currentPrompt ? `${currentPrompt}\n\n${template}` : template;
}
