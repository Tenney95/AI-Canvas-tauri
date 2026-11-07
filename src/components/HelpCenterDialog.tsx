/**
 * 按需加载的帮助中心，包含分类内容、操作演示与弹窗展示。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import { useAppStore } from '../store/useAppStore';
import HelpMentionDemo from './HelpMentionDemo';
import ModalOverlay from './shared/ModalOverlay';
import PopupCloseButton from './shared/PopupCloseButton';
import { useT } from '../i18n';

const HELP_CATEGORIES = [
  {
    id: 'getting-started',
    label: '快速开始',
    icon: 'mdi:rocket-launch-outline',
    summary: '从创建节点到获得第一份结果',
    items: [
      {
        title: '创建内容节点',
        description: '点击左侧加号选择文本、图像、视频、音频、全景、动画或 3D 导演台节点。也可以直接按数字键 1-7 快速创建对应节点。',
      },
      {
        title: '补充输入与模型',
        description: '选中节点后填写提示词、选择模型，并按需要添加参考素材。模型不可用时，先到“设置 > API Key”完成对应服务配置。',
      },
      {
        title: '生成并继续编排',
        description: '在节点中发起生成。结果会保留在当前项目中，可继续连接到下游节点，也可在左侧“输出历史”中回看。',
      },
    ],
  },
  {
    id: 'canvas',
    label: '画布导航',
    icon: 'mdi:cursor-move',
    summary: '选择、平移、缩放与快速定位',
    items: [
      {
        title: '选择与多选',
        description: '点击节点进行选择；按住 Shift 点击可追加选择。框选手势会跟随“设置 > 常规”中的画布交互模式。',
        shortcut: 'Shift + 点击',
      },
      {
        title: '平移与缩放',
        description: 'Figma 模式使用右键或中键拖动画布、滚轮缩放；经典模式使用左键拖动画布、Ctrl + 滚轮缩放。触控板可直接使用双指手势。',
      },
      {
        title: '找回画布内容',
        description: '按 F 将全部内容适配到当前视野；按 M 显示或隐藏小地图。画布右下角的缩放控件可精确调整比例。',
        shortcut: 'F / M',
      },
      {
        title: '使用画布右键菜单',
        description: '在画布空白处右键可创建生成节点或源节点，也可粘贴、撤销、重做和打开项目文件夹；存在选中内容时还可复制节点文件或删除所选内容。',
        shortcut: '右键画布空白处',
      },
    ],
  },
  {
    id: 'nodes',
    label: '节点与连线',
    icon: 'mdi:vector-polyline',
    summary: '组织节点、建立数据流与批量编辑',
    items: [
      {
        title: '移动与编辑节点',
        description: '拖动节点标题区域调整位置。单独选中一个节点后按 Space，可直接打开该节点的提示词对话框，集中调整提示词、参数和参考内容。',
        shortcut: '选中节点 + Space',
      },
      {
        title: '自定义节点工具栏',
        description: '单独选中节点后，长按节点上方的浮动工具栏可进入工具栏编辑状态；可添加、移除或拖拽排序按钮，完成后会保存当前布局。',
        shortcut: '长按节点上方工具栏',
      },
      {
        title: '连接上下游',
        description: '从节点的输出连接点拖向另一个节点的输入连接点。把连线释放到画布空白处时，可从菜单中创建后续节点。',
      },
      {
        title: '批量整理',
        description: '多选节点后可使用浮动工具栏对齐、分布或分组。Ctrl + G 用于分组或取消分组，误操作可用 Ctrl + Z 撤销。',
        shortcut: 'Ctrl/⌘ + G',
      },
      {
        title: '快速复制与节点菜单',
        description: '按住 Ctrl/⌘ 拖动非分组节点，会在原位置留下一个副本。右键节点可复制、剪切、创建副本、另存为或打开文件位置，媒体节点还会按类型提供角色库和外部编辑器入口。',
        shortcut: 'Ctrl/⌘ + 拖动节点',
      },
    ],
  },
  {
    id: 'shortcuts',
    label: '快捷操作',
    icon: 'mdi:keyboard-outline',
    summary: '少点几次鼠标，更快完成高频编辑',
    items: [
      {
        title: '快速打开提示词',
        description: '先单独选中一个普通内容节点，再按 Space 打开提示词对话框。正在输入文字、多选节点、分组节点或 Markdown 节点时不会触发。',
        shortcut: '选中节点 + Space',
      },
      {
        title: '锁定节点缩放比例',
        description: '拖动节点右下角的尺寸控制点时按住 Shift，宽高会按当前比例一起变化；拖拽过程中也可以随时按下或松开 Shift 切换。',
        shortcut: '拖拽缩放 + Shift',
      },
      {
        title: '在鼠标位置创建节点',
        description: '按 1-7 创建文本、图像、视频、音频、全景、动画和 3D 导演台节点；按 Alt + 1-5 创建文本、图像、视频、音频和 Markdown 源节点。',
        shortcut: '1-7 / Alt + 1-5',
      },
      {
        title: '复制、粘贴与删除',
        description: 'Ctrl/⌘ + C 和 Ctrl/⌘ + V 用于复制、粘贴选中节点；未复制节点时，直接粘贴外部图片或文件会将内容导入画布。Delete 或 Backspace 删除当前选择。',
        shortcut: 'Ctrl/⌘ + C / V',
      },
      {
        title: '保存、撤销与重做',
        description: 'Ctrl/⌘ + S 保存当前项目；Ctrl/⌘ + Z 撤销；Ctrl/⌘ + Y 或 Ctrl/⌘ + Shift + Z 重做。快捷键在输入框内会优先保留文字编辑行为。',
        shortcut: 'Ctrl/⌘ + S / Z / Y',
      },
      {
        title: '定位与资源搜索',
        description: 'F 适配全部画布内容，M 切换小地图，Esc 关闭当前弹窗或菜单。Alt + Space 或 Ctrl + Shift + Space 可打开资源搜索窗口。',
        shortcut: 'F / M / Esc',
      },
    ],
  },
  {
    id: 'generation',
    label: 'AI 生成',
    icon: 'mdi:creation-outline',
    summary: '配置模型、引用素材与处理生成结果',
    items: [
      {
        title: '配置服务',
        description: '在“设置 > API Key”中添加模型服务和密钥。ComfyUI 用户还需在对应设置页配置服务地址或安装目录。',
      },
      {
        title: '选择正确的输入',
        description: '不同媒体节点会显示各自支持的参数。参考图、首尾帧或音频素材可通过节点连接或节点内的素材入口补充。',
      },
      {
        title: '批量生成图片',
        description: '图片节点使用支持批量的普通模型且未选择工作流时，填写提示词后长按生成按钮，可选择一次生成 2-8 张；费用可能按实际张数计算。',
        shortcut: '长按图片生成按钮',
      },
      {
        title: '使用 ComfyUI 工作流',
        description: '先在“设置 > ComfyUI”配置服务并进入工作流管理，导入工作流 JSON、确认分类和输入节点。保存后可在对应生成节点的模型选择器中直接选择。',
      },
      {
        title: 'ComfyUI 调用要指定输入节点',
        description: '未设置默认节点时，ComfyUI 调用需要在提示词中 @ 对应节点，提示词或参考图才会写入该输入。在工作流管理里展开工作流卡片、点击节点徽章设为该类型默认节点（显示为 ★），之后调用会自动注入，无须每次 @。',
        shortcut: '@节点 / ★ 默认节点',
      },
      {
        title: '留意付费操作',
        description: '通过画布助手生成图片、视频或音频时，本轮应显式 @ 对应模型；B 协作模式会在实际调用前确认，C 自主模式和 MCP 控制会直接执行。',
      },
    ],
  },
  {
    id: 'director',
    label: '3D 导演台',
    icon: 'mdi:video-3d',
    summary: '用白模规划空间、走位与运镜，再交给视频模型',
    items: [
      {
        title: '什么时候需要白模',
        description: '指定路径、多人站位、遮挡、依次揭示人物或道具交接，适合先做白模预演。普通近景说话、转头与常规表演可直接使用图片参考，不必每条视频都先建模。',
      },
      {
        title: '选择合适的导演运行时',
        description: '按 7 创建导演节点，在节点中选择运行时并双击打开。轻量导演台用于手动摆放；AI 镜头预演用文字安排整体位置、旋转和连续单镜头，内置人形四肢固定，改名称不能得到跪姿或抬臂，不支持骨骼、手指、物理模拟或自动避障。精细关节动画和多镜头切换需在 Blender 实际制作，编辑后先“保存返回”再导出。',
      },
      {
        title: '先定场景，再搭可用空间',
        description: '固定环境先准备场景图，再还原可用粗空间；没有固定图时，用文字说明门、楼梯及门后空间。单张图没展示的区域要补充说明，白模不等于准确复原整栋建筑。保留影响路线与遮挡的门框、楼梯、柱廊，不必制作墙皮和锈迹。',
      },
      {
        title: '只控站位与路线：用几何占位',
        description: '只需确定站位、粗略路线或入画时机时，用圆柱、雪人形占位即可。普通走路不必先制作僵硬步态；动作戏也可只用占位控制路线与相机，省去动作制作，但具体招式会更依赖文字描述和视频模型。',
      },
      {
        title: '姿态有要求：用四肢清楚的人形',
        description: '判断依据是要锁定的姿态与接触关系，不只是动作幅度。即使人物完全不动，跪地、手腕被布带向上牵住、身体后仰等特殊姿态，也应先用四肢清楚的粗模摆出膝落点、抬臂和躯干方向，必要时在 Blender 完成，再用成片提示词补充受力与动作状态。',
      },
      {
        title: '精准接触与动作：用骨骼和连续动画',
        description: '精准抛接、接触或高难度打斗需要骨骼和连续动画，也可适配现成动作，不能只靠两个静态姿势或物体平移。简化占位能给视频模型发挥空间，但也会减少动作控制；粗模细节和僵硬动作可能带入成片，应按所需精度选择，避免一味简化或堆细节。',
      },
      {
        title: '先路线，再摄影机',
        description: '可在俯视草图给主体标 C1/C2，画清起点、转折、终点与到达时间，再说镜头从哪里开始、经过谁、最后拍到谁，并补充景别、焦距与朝向。图片须显式 @ 引用并选择支持视觉输入的模型。保留影响轮廓、接触和遮挡的必要结构，白模并非越粗越好。',
      },
      {
        title: '可复制的 8 秒单镜头示例',
        description: '8 秒，16:9，35mm，全程一个连续镜头。人物 A 用圆柱占位，不制作步态，沿走廊中线向前移动；0–4 秒摄影机在背后保持距离跟拍；4–6 秒从 A 右侧沿弧线绕到正面，注视点跟随占位上部；6–8 秒 A 停下，摄影机保持正面中景。保持走廊尺度和 A 的对应关系，不穿墙、不穿人；人物外观与自然步态留给成片。',
      },
      {
        title: '局部修改要指定时间与对象',
        description: '例如：“只改 4–6 秒摄影机，从人物右侧绕到正面，结束时为中景；锁定人物路线、场景、总时长和其他时段。”一次聚焦一个问题，写清起止状态，避免“更震撼”等无法核对的要求。',
      },
      {
        title: '先核对关键时刻，再看完整运动',
        description: '先检查开场、中段、结束的景别、遮挡和人物位置，再完整播放核对连续运动。确认后导出可播放的渲染视频供模型参考；可编辑的场景与 Blender 工程继续保留，方便回改路线和穿帮，交给视频模型的是画面，不是 .blend 工程。',
      },
      {
        title: '人物图、场景图与白模各司其职',
        description: '人物图提供长相和服装，场景图提供环境外观与材质，布局要与白模对齐；白模视频提供随时间变化的空间和运动。标明各主体对应素材，白模颜色只作识别。成片按人物和场景参考还原外观，不带入素材板背景、测试场地、其他演示人物或简模材质。',
      },
      {
        title: '完整运镜要引用导出的视频',
        description: '导出参考视频后，用旁边新增的视频素材节点作为下游参考；导演节点连线只提供截图，静态截图不能传递完整运动。选择支持视频参考的模型与模式，核对时长、画幅和素材限制。预演能提供依据，不能保证 AI 严格复现每帧。',
      },
      {
        title: '成片提示词写清素材和动作链',
        description: '按“连续镜头概要 → 实际 @ 素材与人物/道具编号对应 → 分时可见变化”写。例如：“A 对应人物图，白模约束空间与关键时机，外观按图片；0–4 秒……；4–6 秒……；6–8 秒……”。左右按当前摄影机画面描述，身份编号不随视角改换。保留指定空间与时机，其余自然动作和相机惯性在成片重演；每段写清可见动作链，少重复背景，不只给静态姿势换皮。明确入画主体，画外声音不等于对应人物必须入画。',
      },
      {
        title: '道具交接要写清身份与状态',
        description: '同一道具固定编号并对应实际参考图，标明 A 手持 → 离手与飞行 → B 接触并握住的发生时间，避免凭空复制或换形。精确交接须先在支持的动画工具中实际制作，再核对成片；AI 预演没有手指骨骼，文字要求不能保证接触精度。',
      },
      {
        title: '情绪写成有先后的可见反应',
        description: '成片提示可写“嘴角松动，随后下巴轻颤；视线先移开，头再转开并低下；泪水沿原有湿痕滑落”，比只写“很悲伤”更便于表达。白模负责空间与构图，这些精细表情属于成片表演要求，不是 AI 简模已有的面部动画。',
      },
      {
        title: '长镜头分段时检查交界状态',
        description: '先在同一 Blender 工程的连续时间线上排好，再按所选视频模型的实际时长限制分段导出和分别生成。核对段末与下一段开头的人物、道具状态、机位、朝向和画幅，保留同一套素材对应。导演台不会自动分段，也不保证分段生成后连续；不要把教程时长当作所有模型的上限。',
      },
      {
        title: '先预览，再按问题所在层修正',
        description: '先选择最容易出错的一小段做成片试验。先用“两个人、一个空间”的小例打通流程，再尝试特定姿态和复杂动作。从最早出错的层修正：空间错回导演台改白模；动作僵硬补起势、受力与接触过程，必要时在 Blender 制作；人物串换核对素材对应和交接时间，再生成成片。',
      },
    ],
  },
  {
    id: 'commands',
    label: '快捷指令与 Skill',
    icon: 'mdi:lightning-bolt-outline',
    summary: '复用提示词、串联步骤并加载只读能力',
    items: [
      {
        title: '打开 / 指令菜单',
        description: '在生成节点的提示词输入框中键入 /，或点击输入框下方的 / 按钮，可打开内置指令、自定义快捷指令和 Skill 菜单。',
        shortcut: '输入 /',
      },
      {
        title: '调用内置快捷指令',
        description: '内置指令会按当前节点类型提供可用模板；选择后可能直接发起生成，也可能先展开子菜单或把内容填入提示词供你继续修改。',
      },
      {
        title: '创建自己的快捷指令',
        description: '在 / 菜单中进入“管理快捷指令”，可设置名称、模板、触发方式、模型和图片尺寸；高级模式还能定义参数与多步骤生成序列，任一步失败都会停止后续执行。',
      },
      {
        title: '上传并引用 Skill',
        description: '可从 / 菜单上传 Skill 文本文件或文件夹；桌面端也支持 .zip、.tar.gz、.tgz 压缩包，自动读取入口和文本资料。导入后可在提示词中引用，Skill 内容不能修改应用权限或确认规则。',
      },
    ],
  },
  {
    id: 'projects',
    label: '项目与文件',
    icon: 'mdi:folder-outline',
    summary: '切换项目、导入素材与管理产出',
    items: [
      {
        title: '管理项目',
        description: '点击左上角项目入口可新建、切换或删除项目。每个项目拥有独立的画布、对话、任务、资产和记忆。',
      },
      {
        title: '导入本地素材',
        description: '从左侧加号选择“上传文件”，或将支持的文件拖入画布。素材会按类型创建为可继续连接和编辑的节点。',
      },
      {
        title: '查找历史内容',
        description: '“资产”用于浏览项目素材，“输出历史”用于回看生成结果。文件保存位置和外部程序路径可在设置中管理。',
      },
    ],
  },
  {
    id: 'assets',
    label: '资产与角色',
    icon: 'mdi:image-multiple-outline',
    summary: '搜索、复用并沉淀项目中的视觉资产',
    items: [
      {
        title: '复用项目与全局资产',
        description: '“资产”面板可切换项目文件和全局资产，按名称、类型或标签筛选。将可拖拽的卡片拖回画布，会按媒体类型创建对应节点。',
      },
      {
        title: '整理短剧资产',
        description: '短剧资产用于集中管理人物、场景和关键道具的简介与绑定图片，便于后续在提示词和生成流程中重复引用。',
      },
      {
        title: '建立角色多图参考',
        description: '可新建角色，或从图片节点右键选择“添加到角色库”。角色支持项目与全局两种范围，并可继续从画布补充多张视角参考图。',
      },
      {
        title: '回看并定位生成结果',
        description: '“输出历史”会保留文本和媒体生成记录，可复制文本、线上地址或本地路径，也可回到对应画布节点；删除历史只应在确认不再需要记录后进行。',
      },
      {
        title: '跨范围搜索资产',
        description: '按 Alt + Space 或 Ctrl + Shift + Space 打开资源搜索，可聚合查询项目文件、全局资产和已添加的外部文件夹，并将结果拖入画布。',
        shortcut: 'Alt + Space',
      },
    ],
  },
  {
    id: 'assistant',
    label: '画布助手',
    icon: 'mdi:message-processing-outline',
    summary: '用自然语言查询、配置并执行项目任务',
    items: [
      {
        title: '理解项目与画布',
        description: '查询当前项目、画布结构、节点、连线、可用模型、工作流、对话和任务状态；需要时还可发起独立的只读专家复核。',
      },
      {
        title: '编辑画布内容',
        description: '选择、新建和批量更新节点，建立连线、组合或删除节点，并可撤销或重做画布操作。创建节点与实际调用生成模型是两个独立步骤。',
      },
      {
        title: '生成媒体内容',
        description: '生成图片、视频、音乐或语音，并把结果交付到对话或画布。B 协作模式每次实际调用都需要确认；C 自主模式和 MCP 控制直接执行，且不会自动重试付费调用。',
      },
      {
        title: '管理快捷指令',
        description: '查询和读取已有快捷指令，按你的要求创建或修改快捷指令，也可填写参数并分步执行其中的文本、图片、视频或音频流程。',
      },
      {
        title: '根据接口文档补全 API 配置',
        description: '读取你明确提供的 HTTPS 厂商接口文档，整理模型、请求、响应和轮询配置，生成草稿并在你确认后保存到“API Key”设置；真实 API Key 仍由你本人填写。',
      },
      {
        title: '联网查找资料',
        description: '搜索最新网络资料、读取公开网页并继续浏览相关链接，在回答中保留可追溯来源。网页内容只作为不可信资料读取，不能改变助手权限。',
      },
      {
        title: '处理授权文件',
        description: '列出并读取你为当前对话授权的 UTF-8 文本文件，将内容导入画布源节点，或通过原生保存对话框写出文本文件；助手不会看到本地绝对路径。',
      },
      {
        title: '建立项目记忆',
        description: '根据对话提议保存简短的项目约定、偏好或事实，供后续会话使用。B 协作模式需要确认；C 自主模式和 MCP 控制直接写入。',
      },
      {
        title: '引用对象并控制任务',
        description: '可在输入中 @ 节点、模型、声音或资产来减少歧义。任务步骤会显示在时间线中，可暂停、继续或取消；B 模式对写操作保留确认，C 模式自动执行全部已注册工具。',
      },
    ],
  },
  {
    id: 'maintenance',
    label: '设置与维护',
    icon: 'mdi:tune-variant',
    summary: '配置操作环境、桌面集成与本地存储',
    items: [
      {
        title: '调整外观与操作习惯',
        description: '在“设置 > 常规”中切换画布背景、交互方式、玻璃外框和侧边栏显示方式；完整按键说明可在“设置 > 快捷键”中查看。',
      },
      {
        title: '配置文件与外部应用',
        description: '“设置 > 文件与应用”可选择文件保存根目录，并配置 Photoshop、剪映专业版和 Premiere Pro。配置后，本地媒体节点的右键菜单会显示相应入口。',
      },
      {
        title: '检查存储健康',
        description: '“设置 > 存储健康”可扫描空间占用、回收站残留、孤儿文件、重复文件和离线文件夹。清理前应先核对列表，避免删除仍需保留的本地素材。',
      },
      {
        title: '使用 MCP 本地控制',
        description: '桌面端可在“设置 > MCP 控制”开启本地控制会话，并把配置片段粘贴到 Claude Desktop / Cursor 等客户端。MCP 可无须应用内确认地执行当前已注册且可用的全部工具；参数校验、项目与画布 revision 校验、文件路径授权、审计、取消和撤销边界仍然生效。',
      },
    ],
  },
] as const;

type HelpCategoryId = (typeof HELP_CATEGORIES)[number]['id'];

interface HelpDemoConfig {
  caption: string;
  steps: readonly {
    icon: string;
    label: string;
    tone: string;
  }[];
}

const HELP_DEMOS = {
  'getting-started': {
    caption: '创建节点，补充模型与输入，然后获得第一份生成结果。',
    steps: [
      { icon: 'lucide:plus', label: '创建节点', tone: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-400' },
      { icon: 'lucide:settings-2', label: '选择模型', tone: 'border-blue-400/25 bg-blue-500/10 text-blue-400' },
      { icon: 'lucide:sparkles', label: '生成结果', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
  canvas: {
    caption: '先选中内容，再平移或缩放画布，最后快速适配全部节点。',
    steps: [
      { icon: 'lucide:mouse-pointer-2', label: '选择内容', tone: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-400' },
      { icon: 'lucide:move', label: '平移缩放', tone: 'border-cyan-400/25 bg-cyan-500/10 text-cyan-400' },
      { icon: 'lucide:scan', label: '适配视野', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
  nodes: {
    caption: '选中节点后按 Space，可直接进入提示词与参数编辑。',
    steps: [
      { icon: 'lucide:box-select', label: '选中节点', tone: 'border-blue-400/25 bg-blue-500/10 text-blue-400' },
      { icon: 'lucide:keyboard', label: '按 Space', tone: 'border-amber-400/25 bg-amber-500/10 text-amber-400' },
      { icon: 'lucide:panel-top-open', label: '打开编辑', tone: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-400' },
    ],
  },
  shortcuts: {
    caption: '拖动节点尺寸时按住 Shift，可随时切换为等比缩放。',
    steps: [
      { icon: 'lucide:move-diagonal-2', label: '拖动尺寸', tone: 'border-blue-400/25 bg-blue-500/10 text-blue-400' },
      { icon: 'lucide:arrow-up', label: '按住 Shift', tone: 'border-amber-400/25 bg-amber-500/10 text-amber-400' },
      { icon: 'lucide:proportions', label: '锁定比例', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
  generation: {
    caption: '在画布助手中明确引用模型，确认调用后再生成媒体内容。',
    steps: [
      { icon: 'lucide:at-sign', label: '引用模型', tone: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-400' },
      { icon: 'lucide:badge-check', label: '确认调用', tone: 'border-amber-400/25 bg-amber-500/10 text-amber-400' },
      { icon: 'lucide:image', label: '生成内容', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
  director: {
    caption: '先规划空间与路线，预览关键时刻，再导出白模参考供视频生成。',
    steps: [
      { icon: 'lucide:route', label: '规划路线', tone: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-400' },
      { icon: 'lucide:play', label: '预览修改', tone: 'border-blue-400/25 bg-blue-500/10 text-blue-400' },
      { icon: 'lucide:video', label: '导出参考', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
  commands: {
    caption: '打开 / 菜单，选择快捷指令或 Skill，再决定直接执行或继续编辑。',
    steps: [
      { icon: 'lucide:slash', label: '打开菜单', tone: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-400' },
      { icon: 'lucide:library-big', label: '选择能力', tone: 'border-amber-400/25 bg-amber-500/10 text-amber-400' },
      { icon: 'lucide:play', label: '填入或执行', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
  projects: {
    caption: '项目、导入素材与资产历史保持在同一个独立工作空间中。',
    steps: [
      { icon: 'lucide:folder-plus', label: '新建项目', tone: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-400' },
      { icon: 'lucide:file-up', label: '导入素材', tone: 'border-blue-400/25 bg-blue-500/10 text-blue-400' },
      { icon: 'lucide:archive', label: '管理资产', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
  assets: {
    caption: '搜索现有资产，选择合适版本，再拖入画布或沉淀为角色参考。',
    steps: [
      { icon: 'lucide:search', label: '搜索筛选', tone: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-400' },
      { icon: 'lucide:images', label: '选择资产', tone: 'border-blue-400/25 bg-blue-500/10 text-blue-400' },
      { icon: 'lucide:panel-top-open', label: '拖入画布', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
  assistant: {
    caption: '描述任务并确认执行计划，助手会把每一步结果写回正确项目。',
    steps: [
      { icon: 'lucide:message-square', label: '描述任务', tone: 'border-blue-400/25 bg-blue-500/10 text-blue-400' },
      { icon: 'lucide:list-checks', label: '确认计划', tone: 'border-amber-400/25 bg-amber-500/10 text-amber-400' },
      { icon: 'lucide:workflow', label: '执行画布', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
  maintenance: {
    caption: '先完成环境配置，再扫描存储状态，按需连接桌面与外部工具。',
    steps: [
      { icon: 'lucide:settings-2', label: '配置环境', tone: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-400' },
      { icon: 'lucide:scan-search', label: '扫描存储', tone: 'border-amber-400/25 bg-amber-500/10 text-amber-400' },
      { icon: 'lucide:plug-zap', label: '连接工具', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400' },
    ],
  },
} satisfies Record<HelpCategoryId, HelpDemoConfig>;

function HelpDemo({ categoryId }: { categoryId: HelpCategoryId }) {
  const t = useT();
  const rootRef = useRef<HTMLElement>(null);
  const [playbackKey, setPlaybackKey] = useState(0);
  const demo = HELP_DEMOS[categoryId];

  useEffect(() => {
    const root = rootRef.current;
    if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let cancelled = false;
    let context: { revert: () => void } | undefined;

    // GSAP is only needed while the help demo is mounted.
    void import('gsap').then(({ gsap }) => {
      if (cancelled || !rootRef.current) return;

      context = gsap.context(() => {
        const steps = gsap.utils.toArray<HTMLElement>('[data-help-demo-step]');
        const connectors = gsap.utils.toArray<HTMLElement>('[data-help-demo-connector]');
        const caption = root.querySelector<HTMLElement>('[data-help-demo-caption]');

        gsap.set(steps, { opacity: 0.35, transform: 'translateY(4px) scale(0.96)' });
        gsap.set(connectors, {
          opacity: 0.35,
          transform: 'scaleX(0)',
          transformOrigin: 'left center',
        });
        if (caption) gsap.set(caption, { opacity: 0, transform: 'translateY(4px)' });

        const timeline = gsap.timeline();
        steps.forEach((step, index) => {
          timeline.to(step, {
            opacity: 1,
            transform: 'translateY(0) scale(1)',
            duration: 0.28,
            ease: 'power3.out',
          }, index === 0 ? 0 : '>+0.06');

          const connector = connectors[index];
          if (connector) {
            timeline.to(connector, {
              opacity: 1,
              transform: 'scaleX(1)',
              duration: 0.32,
              ease: 'power2.inOut',
            }, '>-0.04');
          }
        });

        if (caption) {
          timeline.to(caption, {
            opacity: 1,
            transform: 'translateY(0)',
            duration: 0.24,
            ease: 'power3.out',
          }, '>-0.05');
        }
      }, root);
    });

    return () => {
      cancelled = true;
      context?.revert();
    };
  }, [categoryId, playbackKey]);

  return (
    <section
      ref={rootRef}
      aria-label={t('{caption} 操作演示', { caption: t(demo.caption) })}
      className="help-dialog__demo relative mb-5 overflow-hidden rounded-lg border border-canvas-border bg-canvas-bg/60 px-3 py-3"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(var(--separator-color)_1px,transparent_1px)] [background-size:12px_12px]"
        aria-hidden="true"
      />
      <div className="relative mb-3 flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-canvas-text-secondary">{t('操作演示')}</span>
        <button
          type="button"
          aria-label={t('重新播放操作演示')}
          data-tooltip={t('重新播放')}
          onClick={() => setPlaybackKey((key) => key + 1)}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
        >
          <Icon icon="lucide:rotate-ccw" width="14" height="14" aria-hidden="true" />
        </button>
      </div>

      <div className="relative flex min-h-14 items-center">
        {demo.steps.map((step, index) => (
          <div key={step.label} className="contents">
            <div
              data-help-demo-step
              className={`flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1.5 rounded-lg border px-1.5 ${step.tone}`}
            >
              <Icon icon={step.icon} width="17" height="17" aria-hidden="true" />
              <span className="max-w-full truncate text-[10px] font-medium text-canvas-text-secondary">{t(step.label)}</span>
            </div>
            {index < demo.steps.length - 1 ? (
              <div
                data-help-demo-connector
                className="mx-2 h-px min-w-3 flex-[0.35] bg-[var(--separator-color)]"
                aria-hidden="true"
              />
            ) : null}
          </div>
        ))}
      </div>

      <p
        data-help-demo-caption
        className="relative mt-3 text-pretty text-[11px] leading-5 text-canvas-text-secondary"
      >
        {t(demo.caption)}
      </p>
    </section>
  );
}

interface HelpCenterDialogProps {
  onClose: () => void;
}

export default function HelpCenterDialog({ onClose }: HelpCenterDialogProps) {
  const t = useT();
  const canShowCanvasGuide = useAppStore((state) => state.currentProjectId !== null
    && state.projectLoadStatus === 'ready' && !state.settingsOpen);
  const [activeHelpCategory, setActiveHelpCategory] = useState<HelpCategoryId>('getting-started');
  const selectedHelpCategory = HELP_CATEGORIES.find(({ id }) => id === activeHelpCategory)
    ?? HELP_CATEGORIES[0];

  return (
    <>
      {createPortal(
        <ModalOverlay
          isOpen
          onClose={onClose}
          ariaLabel={t('AI Canvas 使用帮助')}
          className="help-dialog h-[min(620px,calc(100vh-24px))] w-[min(760px,calc(100vw-24px))]"
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="help-dialog__header flex shrink-0 items-center justify-between border-b border-canvas-border px-2.5 py-2">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-400">
                  <Icon icon="mdi:book-open-page-variant-outline" width="20" height="20" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-canvas-text">{t('使用帮助')}</h2>
                  <p className="mt-0.5 truncate text-xs text-canvas-text-secondary">{t('按场景查找常用操作和注意事项')}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" className="ui-btn ui-btn--sm" disabled={!canShowCanvasGuide}
                  data-tooltip={canShowCanvasGuide ? t('重新查看画布入口和文件保存位置') : t('进入画布并关闭设置后可查看入口引导')}
                  onClick={() => {
                    onClose();
                    useAppStore.getState().setCanvasGuideOpen(true);
                  }}>{t('入口引导')}</button>
                <PopupCloseButton ariaLabel={t('关闭帮助')} onClick={() => onClose()} />
              </div>
            </header>

            <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
              <nav
                aria-label={t('帮助分类')}
                className="help-dialog__nav flex shrink-0 gap-1 overflow-x-auto border-b border-canvas-border p-2 sm:w-48 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r sm:p-3"
              >
                {HELP_CATEGORIES.map((category) => {
                  const isActive = category.id === activeHelpCategory;
                  return (
                    <button
                      key={category.id}
                      type="button"
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => setActiveHelpCategory(category.id)}
                      className={`help-dialog__category group flex min-w-max items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors sm:min-w-0 ${
                        isActive
                          ? 'bg-indigo-500/15 font-medium text-indigo-300'
                          : 'text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text'
                      }`}
                    >
                      <Icon
                        icon={category.icon}
                        width="16"
                        height="16"
                        className={isActive ? 'text-indigo-400' : 'text-canvas-text-muted group-hover:text-canvas-text-secondary'}
                        aria-hidden="true"
                      />
                      <span>{t(category.label)}</span>
                    </button>
                  );
                })}
              </nav>

              <main className="help-dialog__main min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 sm:py-4">
                <div className="mx-auto max-w-xl">
                  <div className="mb-5">
                    <p className="help-dialog__accent text-[11px] font-medium text-indigo-400">{t(selectedHelpCategory.label)}</p>
                    <h3 className="mt-1 text-lg font-semibold text-canvas-text">{t(selectedHelpCategory.summary)}</h3>
                  </div>

                  <HelpDemo categoryId={activeHelpCategory} />

                  <ol className="space-y-1">
                    {selectedHelpCategory.items.map((item, index) => (
                      <li key={item.title} className="flex gap-4 border-b border-canvas-border/70 py-3 first:pt-0 last:border-b-0">
                        <span className="help-dialog__index flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-canvas-hover text-[11px] font-semibold text-canvas-text-secondary">
                          {index + 1}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="text-sm font-medium text-canvas-text">{t(item.title)}</h4>
                            {'shortcut' in item && item.shortcut ? (
                              <kbd className="rounded-md border border-canvas-border bg-canvas-hover px-1.5 py-0.5 font-sans text-[10px] font-medium text-canvas-text-secondary">
                                {t(item.shortcut)}
                              </kbd>
                            ) : null}
                          </div>
                          <p className="mt-1.5 text-xs leading-5 text-canvas-text-secondary">{t(item.description)}</p>
                        </div>
                      </li>
                    ))}
                  </ol>

                  {activeHelpCategory === 'generation' ? <HelpMentionDemo /> : null}

                  <div className="mt-5 flex items-start gap-2 border-t border-canvas-border pt-4 text-xs leading-5 text-canvas-text-muted">
                    <Icon icon="mdi:keyboard-outline" width="16" height="16" className="mt-0.5 shrink-0" aria-hidden="true" />
                    <p>{t('完整快捷键可在“设置 > 快捷键”中查看；按 Esc 可随时关闭当前弹窗或菜单。')}</p>
                  </div>
                </div>
              </main>
            </div>
          </div>
        </ModalOverlay>,
        document.body,
      )}
    </>
  );
}
