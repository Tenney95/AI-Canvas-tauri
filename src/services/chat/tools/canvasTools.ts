/**
 * 注册画布查询与写入工具，并通过命令注册表、项目校验和 revision 防护执行节点操作。
 */
import type { Node } from '@xyflow/react';
import { useAppStore } from '../../../store/useAppStore';
import { pickImageOutputParameters } from '../../ai/imageOutputParameters';
import { isBatchConnectableNode } from '../../../store/store.nodes';
import type { BaseNodeData } from '../../../types';
import { resolveShotVideoDuration } from '../../../types/shotlist';
import { resolveSingleShotlistRowReference } from '../../shotlistPromptService';
import type { McpOperationItemReceipt } from '../../../types/agent';
import { MAX_IMAGE_BATCH_COUNT } from '../../../types/aiTypes';
import { executeGeneration, type GenerationLease } from '../../generationService';
import { getPendingTasksForProject } from '../../pollManager';
import { recordMcpOperationProgress } from '../../mcp/mcpOperationService';
import { getProjectModelKind, parseProjectModelRef, PROJECT_IMAGE_SIZES } from '../../projectSettingsService';
import { isProjectExpectedContextCurrent } from '../../projectExecutionContext';
import { generationInputSnapshot, getCanvasNodeHash, matchesCanvasNodeSnapshot } from '../canvasNodeVersion';
import { validateAgentToolInput } from '../agentToolSchemas';
import { registerAgentTool, type AgentToolExecutionResult } from '../toolRegistry';
import { isSafeMediaParameterText } from '../../ai/modelCapabilityValidation';
import { findDramaAsset, listGlobalDramaAssets, preferDramaLibraryReferences } from '../../dramaAssetPrompt';
import { AGENT_NODE_LAYOUT, AGENT_NODE_LAYOUT_GUIDANCE } from '../agentCanvasLayout';
import { isTauriEnv } from '../../fileService';
import {
  AGENT_CREATABLE_NODE_TYPES,
  isSourceNodeType,
  ASPECT_RATIOS,
  TEXT_OUTPUT_NODE_TYPES,
  TEXT_FILE_NODE_TYPES,
  AUDIO_FORMATS,
  SPEECH_STYLES,
  mediaSettingsIssue,
  DETAIL_NODE_LIMIT,
  TEXT_READ_LIMIT,
  MAX_RUN_NODES,
  type NodeTargetInput,
  type CreateNodesInput,
  type QueryNodesInput,
  type NodeUpdatePatch,
  type UpdateNodesInput,
  type ConnectNodesInput,
  type DisconnectNodesInput,
  displayPreview,
  createNodesInputDisplay,
  buildUpdateChanges,
  targetProperties,
  nodeUpdateProperties,
  nodeUpdatePatchSchema,
  isSourceOnlyNode,
} from './canvas/nodeInputs';
import {
  isCurrentProject,
  authorizeCurrentProject,
  assertCanvasRevision,
  removeMissingDramaMentions,
  repairMissingCloudOutputs,
  type TextFileTarget,
  textFileSaveKey,
  textFileTargetsFresh,
  prepareTextFileUpdates,
  type TextFilePersistenceStatus,
  persistTextFileUpdates,
  readGlobalReferenceAssets,
  hasActualNodeReference,
  resolveTargetIds,
  queryNodes,
  captureNodeVersionContext,
  assertNodeVersionSnapshot,
  readCanvasText,
  buildCanvasDetail,
  resolveModelPatch,
  executeCanvasCommand,
  resolveCreateNodePositions,
  createCanvasNode,
  describeConnectionLayout,
  buildPromptReferenceEdges,
  type PreparedNodeUpdate,
  prepareNodeUpdate,
  applyPreparedNodeUpdates,
} from './canvas/nodeOperations';

export function registerCanvasAgentTools(): Array<() => void> {
  return [
    registerAgentTool<QueryNodesInput>({
      id: 'canvas_query',
      resultPolicy: { storage: 'memory', source: 'project-derived' },
      title: '查询画布',
      description: [
        '读取画布概况和节点名称索引；按 name 搜索可见名称、文件名别名或内部名称，默认包含匹配，nameMatch=exact 为精确匹配。',
        '多个筛选条件取交集；未找到返回空列表，不回退全画布。重名返回全部候选，核对 ID 后再写入。offset/limit 分页，hasMore=true 时用 nextOffset 继续。',
        'detail=true 时额外返回结构化节点详情：ID、坐标、尺寸、模型、生成参数、提示词、',
        '文本输出摘要和相关连线（含实际端口、水平间距与布局提醒），用于精确定位后再调用更新、连接或运行工具。',
        'detail=true 的每个节点及 textField 结果返回 nodeHash，覆盖完整可编辑输入、名称、位置和项目设置；更新时原样放入 expectedNodeHash，避免未增加 revision 的手工改稿被覆盖。普通名称索引不计算指纹。',
        '长文字须显式用 nodeIds 或 displayIds 恰好定位一个节点，再指定 textField=prompt 或 output；仅返回所选当前字段的原文片段与 revision，不返回其它节点详情。output 只支持文本类节点。',
        'textOffset/nextOffset 是 JavaScript UTF-16 代码单元偏移；保持节点和字段不变，用 nextOffset 续读到 null。textLimit 默认及上限为 4000，实际片段会按 JSON 预算缩小且不拆 Unicode 代理项对；原文首尾空白保留。未指定 textField 时仍返回 400 字详情摘要。',
        '不会返回本地路径或媒体 URL。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          ...targetProperties,
          detail: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: DETAIL_NODE_LIMIT },
          offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          name: { type: 'string', minLength: 1, maxLength: 200, description: '节点可见名称、文件名别名或内部名称；不搜索提示词正文。' },
          nameMatch: { type: 'string', enum: ['contains', 'exact'] },
          textField: { type: 'string', enum: ['prompt', 'output'], description: '只续读明确单个节点的当前提示词或文本正文；与普通节点详情分页独立。' },
          textOffset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: '所选文字字段的 UTF-16 偏移，默认 0；沿用返回的 nextOffset，不能切入代理项对。' },
          textLimit: { type: 'integer', minimum: 1, maximum: TEXT_READ_LIMIT, description: '文字片段的 UTF-16 长度上限，默认 4000；JSON 转义较多时实际步长会缩小。' },
        },
        additionalProperties: false,
      },
      effect: 'read',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => input.textField !== undefined
        ? `续读节点${input.textField === 'prompt' ? '提示词' : '正文'}片段`
        : `查询画布节点${input.detail ? '详情' : '名称索引'}`,
      execute: async (context, input) => {
        if (context.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
        if (!isCurrentProject(context.projectId)) throw new Error('目标项目当前未加载');
        if (input.name !== undefined && !input.name.trim()) {
          return { status: 'error', summary: '名称不能是空白，请填写名称或省略 name', modelContent: '名称不能是空白，请填写名称或省略 name' };
        }
        const matched = queryNodes(input);
        if (input.textField !== undefined) return readCanvasText(context, input, matched);
        if (input.textOffset !== undefined || input.textLimit !== undefined) {
          return { status: 'error', summary: 'textOffset/textLimit 需要同时指定 textField', modelContent: 'textOffset/textLimit 需要同时指定 textField' };
        }
        const offset = input.offset ?? 0;
        const page = matched.slice(offset, offset + (input.limit ?? DETAIL_NODE_LIMIT));
        const version = input.detail ? captureNodeVersionContext(context.projectId) : undefined;
        const globalAssets = input.detail && page.length ? await readGlobalReferenceAssets(context) : undefined;
        if (context.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
        if (!isCurrentProject(context.projectId)) throw new Error('目标项目当前未加载');
        const summary = !matched.length ? '没有找到匹配节点'
          : !page.length ? `匹配 ${matched.length} 个节点，此页为空，请从 offset=0 重新查询`
            : `匹配 ${matched.length} 个节点，本页返回 ${page.length} 个`;
        if (version) assertNodeVersionSnapshot(context, page, version);
        const detail = buildCanvasDetail(matched, input, globalAssets);
        if (version) {
          const details = detail.nodes as Array<Record<string, unknown>>;
          // 顺序编码，避免同页多份大提示词同时占用摘要缓冲区。
          for (let index = 0; index < page.length; index += 1) {
            details[index].nodeHash = await getCanvasNodeHash(page[index], context.projectId, version.settings);
            assertNodeVersionSnapshot(context, [page[index]], version);
          }
          assertNodeVersionSnapshot(context, page, version);
        }
        return {
          status: 'success', summary,
          modelContent: JSON.stringify({
            summary,
            ...(!input.detail ? { message: summary, affectedNodeIds: page.map((node) => node.id) } : {}),
            ...detail,
          }),
        };
      },
    }),
    registerAgentTool<NodeTargetInput>({
      id: 'canvas_select',
      title: '选择节点',
      description: '按节点 ID、展示编号、类型、状态或当前选择集选择画布节点。',
      inputSchema: {
        type: 'object',
        properties: targetProperties,
        additionalProperties: false,
      },
      effect: 'read',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `选择 ${resolveTargetIds(input).length} 个节点`,
      execute: async (context, input) => {
        const targetIds = resolveTargetIds(input);
        if (targetIds.length === 0) {
          return { status: 'error', summary: '没有找到匹配节点', modelContent: '没有找到匹配节点' };
        }
        return executeCanvasCommand('select', targetIds, context, '选择节点');
      },
    }),
    registerAgentTool<CreateNodesInput>({
      id: 'canvas_create_nodes',
      title: '新建画布节点',
      description: [
        '在画布上原子创建一个或多个节点；不会自动运行节点模型。',
        AGENT_NODE_LAYOUT_GUIDANCE,
        '角色、场景和道具优先使用 drama_asset_list/get 返回的 @drama 库引用，不为库引用创建连线。只有未入库素材和真实生成依赖使用 @{nodeId:label}；节点引用会自动连线，不要重复连接。MCP 会把能唯一匹配库内同一张图片的节点引用转为精确库引用，保持 Picture 顺序。',
        '为已有资产新建参考图时传 dramaAssetId（仅项目 ai-image），生成成功后自动回填库条目；已有图用 drama_reference_image_add 绑定。先完成绑图再创建下游，不能把只有文字设定的库条目当图片。',
        'type 按这个节点最终要产出什么来选，不要因为内容是文字描述就一律建文本节点：',
        '产物是画面的（角色设定图、场景图、道具图、关键帧、单张分镜）用 ai-image，把画面描述写进 prompt；',
        '产物是镜头的用 ai-video，配乐旁白用 ai-audio，多宫格图片也用 ai-image。分镜表不是视频生成的必建前置；仅需直接制作视频时不额外创建 ai-shotlist 或剧本快照，只有需要逐镜审稿、统一时长或按表剪辑时才建表，并先查询复用已有表。',
        '从外部剧本或分镜导入视频时，必须把来源中明确的每镜秒数传入 videoDuration，不能只写在 prompt 中；小数秒向上取整到实际生成时长。未提供时保留项目默认值，不猜测提示词中的数字。已明确使用软件内现有分镜表制作时，用 shotlist_prepare_production，保留镜头来源和自动时长关联；不默认额外复制每镜全文为文本节点。',
        '直接引用软件内某镜创建视频时，先用 shotlist_read 取得该行 mention，再原样放入 prompt，附加要求写在胶囊外；自动读取最新景别、运镜、画面、对白和音效。省略 videoDuration 跟随该镜时长，明确传入则视为手动覆盖；只连接所属表，不引用整表或编造虚拟镜头 ID。',
        '已确定的模型、图片尺寸/质量/背景/批量、视频长边/帧率/音轨、语音或音乐参数请在创建时一并传入；本地工作流长边像素用 videoLongSide（如 832），API 画质档位用 videoResolution（如 720p）。负数自动时长仅允许所选模型明确声明的值。未提供的字段沿用项目或模型默认值。音频参考素材用 @ 引用，工作流特有参数仍在工作流配置中设置。',
        'ai-storyboard 是把已有图片进行宫格裁切后产生的素材节点，本工具不能直接创建，也不能给它提示词或运行生成。',
        '产物本身就是文字的用 ai-text（markdown 排版用 ai-markdown）。',
        '文本节点分 prompt 和 content 两个口，别混：',
        'content 是已经写好的正文（全局提示词、视觉基调、世界观设定、剧本全文、你自己刚写完的段落），',
        '直接落进节点正文，建完就能看见、能被下游 @{nodeId:label} 引用，不需要再跑模型；',
        'prompt 是给模型的生成指令（“把这集拆成镜头表”），节点正文会留空，等用户点生成才有内容。',
        '你已经写出成品文字时一律放 content；放进 prompt 只会让节点显示空白，引用它也只能拿到空内容。',
        '多图视频 prompt 须按 Picture 顺序写入对应图片节点的 @{nodeId:label} 引用；只有连线不能指定 Picture 顺序。视频 aspectRatio 同时设置实际生成比例和空节点框尺寸，省略时继承项目视频比例；自适应比例不推测尺寸。',
        '视觉节点要按画面内容给 aspectRatio，不要整批用同一个比例：',
        '人物立绘、定妆图用 3:4，场景板、镜头画面、分镜用 16:9，道具、图标、材质用 1:1，竖屏短视频用 9:16，宽银幕气氛图用 21:9；',
        '项目已经定了画幅（如剧本写明 16:9）时，镜头类节点跟随项目画幅，只有人物、道具这类单体参考图才另选比例。',
        '节点框大小由本地按比例和正文长度自动算，不用也不能自己传宽高。',
      ].join(''),
      inputSchema: {
        type: 'object',
        required: ['nodes'],
        additionalProperties: false,
        properties: {
          nodes: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              required: ['type', 'label'],
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: AGENT_CREATABLE_NODE_TYPES },
                label: { type: 'string', minLength: 1, maxLength: 120 },
                prompt: { type: 'string', maxLength: 8000 },
                content: { type: 'string', maxLength: 40000 },
                model: { type: 'string', minLength: 1, maxLength: 240,
                  description: '可用模型 ID；先用 app_get_state 查询，工作流 ID 会正确绑定到节点。' },
                dramaAssetId: { type: 'string', minLength: 1, maxLength: 160,
                  description: '仅 ai-image：已有项目人物/场景/道具 ID；新节点作为其参考图，生成后自动回填资产库。不是提示词输入引用。' },
                aspectRatio: { type: 'string', enum: ASPECT_RATIOS },
                imageSize: { type: 'string', enum: [...PROJECT_IMAGE_SIZES] },
                imageQuality: { type: 'string', minLength: 1, maxLength: 40, description: '仅图片模型声明支持的质量档位。' },
                imageBackground: { type: 'string', maxLength: 40, description: '仅图片模型声明支持的背景；空字符串表示接口默认。' },
                imageOutputFormat: { type: 'string', enum: ['png', 'gif', 'svg'], description: '仅所选图片模型声明的格式；GIF/SVG须符合其方图和文生限制。' },
                imageFrameCount: { type: 'integer', minimum: 1 },
                imageFrameDurationMs: { type: 'integer', minimum: 1 },
                imageTransparent: { type: 'boolean' },
                batchCount: { type: 'integer', minimum: 1, maximum: MAX_IMAGE_BATCH_COUNT },
                videoResolution: { type: 'string', minLength: 1, maxLength: 40,
                  description: 'API 画质档位，如 720p；兼容旧客户端传入数字字符串 832 并映射为长边像素。' },
                videoLongSide: { type: 'integer', minimum: 128, maximum: 4096,
                  description: '本地 ComfyUI / RunningHub 视频长边像素，如 832。' },
                videoDuration: { type: 'number', maximum: 3600,
                  description: '仅 ai-video：秒数支持小数并向上取整；负数仅允许所选模型声明的自动时长值。' },
                videoFps: { type: 'number', minimum: 1, maximum: 240, description: '视频帧率，须符合模型能力。' },
                generateAudio: { type: 'boolean', description: '视频生成音轨开关，须符合模型能力。' },
                audioPurpose: { type: 'string', enum: ['music', 'speech'] },
                audioVoice: { type: 'string', minLength: 1, maxLength: 256, description: '当前模型公布的音色 ID，不含控制字符。' },
                audioFormat: { type: 'string', enum: AUDIO_FORMATS },
                audioSpeed: { type: 'number', minimum: 0.25, maximum: 4 },
                audioSpeechSettings: { type: 'object', additionalProperties: false, properties: {
                  voiceStyle: { type: 'string', enum: SPEECH_STYLES },
                  pace: { type: 'integer', minimum: 0, maximum: 4 },
                  duration: { type: 'integer', minimum: 1, maximum: 3600 },
                } },
                musicDuration: { type: 'integer', minimum: 1, maximum: 240 },
                musicBpm: { type: 'integer', minimum: 1 },
                musicTitle: { type: 'string', maxLength: 120 },
                musicLyrics: { type: 'string', maxLength: 8000 },
                autoGenerateLyrics: { type: 'boolean' },
                x: { type: 'number', minimum: -100000, maximum: 100000, description: '通常省略，由宿主紧凑定位；仅明确需要指定位置时传入。' },
                y: { type: 'number', minimum: -100000, maximum: 100000, description: '通常省略，由宿主紧凑定位；仅明确需要指定位置时传入。' },
              },
            },
          },
        },
      },
      effect: 'canvas_write',
      resolveInput: (input) => {
        for (const node of input.nodes) {
          if ((node.imageQuality !== undefined && !isSafeMediaParameterText(node.imageQuality, 'imageQuality'))
            || (node.imageBackground !== undefined && !isSafeMediaParameterText(node.imageBackground, 'imageBackground'))
            || (node.videoResolution !== undefined && !isSafeMediaParameterText(node.videoResolution, 'resolution'))) {
            throw new Error('媒体参数格式无效，请使用模型声明的参数值');
          }
        }
        return input;
      },
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `新建 ${input.nodes.length} 个画布节点`,
      buildInputDisplay: createNodesInputDisplay,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const storyboardCount = input.nodes.filter((node) => node.type === 'ai-storyboard').length;
        if (storyboardCount > 0) {
          const message = `宫格分镜只能由已有图片裁切产生，不能直接创建（${storyboardCount} 个无效节点）`;
          return { status: 'error', summary: message, modelContent: message };
        }
        const invalidMedia = input.nodes.map((node, index) => ({ index, issue: mediaSettingsIssue(node.type, node) }))
          .find((entry) => entry.issue);
        if (invalidMedia) {
          const message = `第 ${invalidMedia.index + 1} 个节点：${invalidMedia.issue}`;
          return { status: 'error', summary: message, modelContent: message };
        }
        const invalidAsset = input.nodes.find((node) => node.dramaAssetId !== undefined
          && (node.type !== 'ai-image' || !findDramaAsset(useAppStore.getState().dramaAssets, node.dramaAssetId)));
        if (invalidAsset) {
          const message = 'dramaAssetId 只允许 ai-image 关联已存在的项目人物、场景或道具；请先查询资产库';
          return { status: 'error', summary: message, modelContent: message };
        }
        // 媒体节点的 output 存的是本地路径或 URL，写正文进去会直接建出一个坏节点
        const nonText = input.nodes.filter(
          (node) => node.content?.trim() && !TEXT_OUTPUT_NODE_TYPES.has(node.type),
        );
        if (nonText.length > 0) {
          const message = `content 只能用于文本类节点，${nonText.length} 个节点不是文本节点`;
          return { status: 'error', summary: message, modelContent: message };
        }
        const mcp = context.conversationId === `mcp-control-${context.projectId}`;
        const globalAssets = mcp && input.nodes.some((node) => node.prompt && !isSourceNodeType(node.type)
          && !node.content?.trim() && hasActualNodeReference(node.prompt)) ? await readGlobalReferenceAssets(context) : undefined;
        const projectRatio = useAppStore.getState().projects
          .find((project) => project.id === context.projectId)?.settings?.generation?.videoAspectRatio;
        // 布局与落库共用最终视频比例，不能等插入 Store 后才补项目默认值。
        const referenceState = useAppStore.getState();
        const nodeInputs = input.nodes.map((node) => ({
          ...node,
          ...(node.type === 'ai-video' && node.aspectRatio === undefined && projectRatio ? { aspectRatio: projectRatio } : {}),
          ...(mcp && node.prompt && !isSourceNodeType(node.type) && !node.content?.trim()
            ? { prompt: preferDramaLibraryReferences(node.prompt, referenceState.nodes,
              referenceState.dramaAssets, globalAssets ?? listGlobalDramaAssets(referenceState)) } : {}),
        }));
        const positions = resolveCreateNodePositions(context, nodeInputs);
        const nodes = nodeInputs.map((nodeInput, index) => createCanvasNode(
          nodeInput,
          index,
          positions[index],
        ));
        for (let index = 0; index < input.nodes.length; index++) {
          const modelRef = input.nodes[index].model;
          if (!modelRef) continue;
          const resolved = resolveModelPatch(modelRef, [nodes[index]]);
          if ('error' in resolved) {
            return { status: 'error', summary: resolved.error, modelContent: resolved.error };
          }
          Object.assign(nodes[index].data, resolved.patch);
          // 工作流默认值不能覆盖同一次创建明确给出的参数。
          if (input.nodes[index].batchCount !== undefined) nodes[index].data.batchCount = input.nodes[index].batchCount;
          if (input.nodes[index].audioPurpose !== undefined) nodes[index].data.audioPurpose = input.nodes[index].audioPurpose;
        }
        const edgePlan = buildPromptReferenceEdges(nodes, useAppStore.getState().nodes);
        if (edgePlan.error) {
          return { status: 'error', summary: edgePlan.error, modelContent: edgePlan.error };
        }
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes[index];
          if (node.data.type !== 'ai-video') continue;
          try {
            const source = resolveSingleShotlistRowReference(node.data.prompt || '', referenceState.nodes);
            if (!source) continue;
            const explicitDuration = input.nodes[index].videoDuration !== undefined;
            node.data.shotlistProductionSource = { nodeId: source.nodeId, rowId: source.rowId,
              kind: 'video', durationSync: explicitDuration ? 'manual' : 'auto' };
            if (!explicitDuration) node.data.seedanceDuration = resolveShotVideoDuration(source.row.duration);
          } catch (error) {
            const message = error instanceof Error ? error.message : '镜头引用无效';
            return { status: 'error', summary: message, modelContent: message };
          }
        }
        const store = useAppStore.getState();
        store.addNodesWithEdges(nodes, edgePlan.edges);
        // 项目默认值用于填空；MCP 同一次创建中明确给出的参数必须保留，
        // 即使该节点暂时没有提示词。沿用创建的同一条撤销历史。
        const explicitKeys = [
          'model', 'provider', 'workflowId', 'workflowInputs', 'aspectRatio', 'imageSize',
          'imageQuality', 'imageBackground', 'batchCount', 'seedanceRatio', 'seedanceResolution', 'videoResolution', 'seedanceDuration',
          'imageOutputFormat', 'imageFrameCount', 'imageFrameDurationMs', 'imageTransparent',
          'videoFps', 'generateAudio',
          'audioPurpose', 'audioVoice', 'audioFormat', 'audioSpeed', 'audioSpeechSettings',
          'musicDuration', 'musicBpm', 'musicTitle', 'musicLyrics', 'autoGenerateLyrics',
        ] as const;
        for (const node of nodes) {
          const explicit = Object.fromEntries(explicitKeys
            .filter((key) => node.data[key] !== undefined)
            .map((key) => [key, node.data[key]])) as Partial<BaseNodeData>;
          // 显式自适应也要恢复创建时的框，不能遗留项目固定比例产生的中间尺寸。
          if (node.data.type === 'ai-video') {
            explicit.nodeWidth = node.data.nodeWidth;
            explicit.nodeHeight = node.data.nodeHeight;
            if (node.data.shotlistProductionSource?.durationSync === 'auto') delete explicit.seedanceDuration;
          }
          if (Object.keys(explicit).length) store.updateNodeDataTransient(node.id, explicit);
        }
        useAppStore.getState().incrementRevision();
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('canvas-focus-nodes', {
            detail: { nodeIds: nodes.map((node) => node.id) },
          }));
        }
        return {
          status: 'success',
          summary: edgePlan.edges.length > 0
            ? `已新建 ${nodes.length} 个节点并自动连接 ${edgePlan.edges.length} 条引用`
            : `已新建 ${nodes.length} 个节点`,
          modelContent: JSON.stringify({
            nodes: nodes.map((node) => ({
              id: node.id,
              type: node.type,
              label: node.data.label,
              position: node.position,
              ...(node.data.dramaAssetId ? { dramaAssetId: node.data.dramaAssetId, dramaAssetKind: node.data.dramaAssetKind } : {}),
            })),
            edges: edgePlan.edges.map((edge) => ({
              id: edge.id,
              source: edge.source,
              target: edge.target,
            })),
            revision: useAppStore.getState().getCurrentRevision(),
          }),
          display: {
            entities: nodes.map((node) => ({
              id: node.id,
              title: node.data.label,
              fields: [
                { label: '类型', value: node.type ?? node.data.type },
                {
                  label: '位置',
                  value: `(${Math.round(node.position.x)}, ${Math.round(node.position.y)})`,
                  source: 'resolved',
                },
              ],
              preview: displayPreview(node.data.prompt ?? node.data.output),
            })),
          },
        };
      },
    }),
    registerAgentTool<UpdateNodesInput>({
      id: 'canvas_update_nodes',
      title: '更新画布节点',
      description: [
        '批量更新匹配节点：名称、提示词、正文内容、位置、尺寸、生成模型和生成参数。',
        '各节点内容不同时用 updates:[{nodeId,patch}]，每次 1 至 50 项，每项仅接受普通编辑字段。不能与任何顶层筛选、补丁或特殊修复操作混用；重复或不存在的 ID、任一无效补丁都会在写入前整批拒绝，成功时只提交一次历史和 revision。',
        '建议将读取到的 nodeHash 原样传入 expectedNodeHash；顶层前置条件只能用于恰好一个目标，多节点请给 updates 的每个 patch 分别传入。指纹不匹配时整批拒绝并要求重新读取，不自动重投；未提供指纹时保留旧客户端行为。',
        '只改提示词一处时用 promptEdit:{oldText,newText}，不能与整段 prompt 混传。oldText 非空且必须在每个目标的当前原文中唯一出现（重叠重复也拒绝）；任一目标不匹配或参数无效时整批不写。',
        '片段新旧文本各最多 8000 个 UTF-16 代码单元，newText 可为空以删除片段；保留范围外所有原文、空白及存量长提示词，不截断全文。不得切入 @{...}、@asset{...}、@drama{...} 引用令牌或 Unicode 代理项对；可以替换或删除完整引用。MCP 只转换 newText 内的同图节点引用，范围外引用保持原样。',
        'label 同步已有文件名显示别名，但不重命名磁盘文件或改变媒体路径。',
        '角色、场景、道具优先使用库内 @drama 引用；canvas_query(detail=true) 的 preferredMention 给出同图的精确库引用。MCP 更新 prompt 时自动转换能唯一匹配的同图节点引用，不改既有连线；引用明确的镜头输入或分镜单格仍保留节点。',
        '视频 aspectRatio 同步实际生成比例；固定比例按当前宽度重算空节点高度（同时传 width 时使用新宽度，优先于 height），已有成片保持真实视频框，自适应不改框。',
        '视频节点的 videoLongSide 是本地工作流长边像素，videoResolution 是 API 档位（旧版数字字符串会转长边像素）；videoDuration 是实际生成秒数。',
        '音频节点可设置语音音色/格式/速度、描述式语音参数及音乐时长/BPM；工作流专属参数继续由工作流配置管理。',
        'content 改写节点正文，只能用于文本类节点（ai-text / ai-markdown / source-text / comment）。桌面端前三类已关联文件时用真实磁盘摘要校验后保存；冲突或部分文件失败会返回错误与脱敏状态，保留新草稿，不自动重试整批。',
        'updates 在提交前若有文本文件基线读取失败或冲突，整批不改画布；同一文件不能请求不同正文，相同正文合并实际保存。旧顶层补丁仍保留冲突时的新草稿。画布已提交后文件部分保存失败时保留全部草稿并逐项报告，不回滚已保存文件，也不承诺文件系统与画布原子提交。',
        'prompt 里可写 @{nodeId:label} 引用其他节点输出、@drama{assetId:name} 引用资产库设定，生成时自动展开；ID 必须真实存在。多图视频须按 Picture 顺序逐条写入图片节点 @ 引用，仅有连线不能指定 Picture 顺序。',
        '顶层 x/y 是绝对坐标，一次只能移动一个节点；updates 中每项可分别设置 x/y。dx/dy 是相对位移，可批量。',
        'model 必须是 app_get_state 返回的模型 ID，且类型要与节点匹配。',
        'repairMissingCloudOutputs=true 仅按真实项目文件清单清理当前主图仍存在、且同类型单产物旧文件已缺失的云工作流缓存；不改主图、不接受路径或任意 data，也不清理多产物。只能与目标筛选字段一起使用，不能混合名称、提示词、位置或生成参数等普通编辑。',
        'removeMissingDramaMentionIds 指定完整 @drama 引用 ID（含选图后缀，不含外层标记），仅将父项目资产已不存在的匹配 token 替换为显示名称，其余完整 prompt 保持原样。有效资产和 global/ 引用拒绝清理；只能与目标筛选字段一起使用。',
        '不修改已生成的结果，也不会触发生成（生成用 canvas_run_nodes）。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          ...targetProperties,
          repairMissingCloudOutputs: { type: 'boolean', description: '显式为 true 时，仅安全修复缺失的云工作流单产物缓存，不允许混合普通编辑字段。' },
          removeMissingDramaMentionIds: { type: 'array', minItems: 1, maxItems: 20,
            items: { type: 'string', minLength: 1, maxLength: 2048 },
            description: '只清理明确指定且父项目资产已删除的引用 ID，保留显示名称和完整提示词；不能混合普通编辑。' },
          ...nodeUpdateProperties,
          updates: { type: 'array', minItems: 1, maxItems: 50, items: {
            type: 'object', required: ['nodeId', 'patch'], additionalProperties: false, properties: {
              nodeId: { type: 'string', minLength: 1, maxLength: 120 }, patch: nodeUpdatePatchSchema,
            },
          }, description: '每个节点一个独立普通补丁，整批最多 50 项；不能与任何顶层筛选、补丁或特殊修复操作混用。' },
        },
        additionalProperties: false,
      },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => Array.isArray(input.updates) ? `分别更新 ${input.updates.length} 个节点`
        : input.removeMissingDramaMentionIds !== undefined
          ? `清理 ${resolveTargetIds(input).length} 个节点的指定失效资产引用`
          : input.repairMissingCloudOutputs === true
            ? `核对 ${resolveTargetIds(input).length} 个节点的缺失单产物缓存` : `更新 ${resolveTargetIds(input).length} 个节点`,
      execute: async (context, input) => {
        if (context.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
        assertCanvasRevision(context);
        if (!isCurrentProject(context.projectId)) throw new Error('目标项目当前未加载');
        const reject = (message: string): AgentToolExecutionResult => ({ status: 'error', summary: message, modelContent: message });
        const updates = input.updates;
        const batch = updates !== undefined;
        const requests: Array<{ input: NodeUpdatePatch; targetIds: string[] }> = [];
        if (updates !== undefined) {
          if (Object.keys(input).some((key) => key !== 'updates') || !Array.isArray(updates) || updates.length < 1 || updates.length > 50) {
            return reject('updates 需要 1 至 50 项，不能与顶层筛选、补丁或特殊修复操作混用');
          }
          const seen = new Set<string>();
          const known = new Set(useAppStore.getState().nodes.map((node) => node.id));
          for (const item of updates) {
            if (!item || typeof item !== 'object' || Object.keys(item).some((key) => key !== 'nodeId' && key !== 'patch')
              || typeof item.nodeId !== 'string' || !known.has(item.nodeId) || seen.has(item.nodeId)
              || !validateAgentToolInput(nodeUpdatePatchSchema, item.patch).valid) {
              return reject('updates 含重复或不存在的节点 ID，或补丁不符合普通编辑 schema；未修改任何节点');
            }
            seen.add(item.nodeId);
            requests.push({ input: item.patch, targetIds: [item.nodeId] });
          }
        } else {
          const targetIds = resolveTargetIds(input);
          if (targetIds.length === 0) {
            return { status: 'error', summary: '没有找到匹配节点', modelContent: '没有找到匹配节点' };
          }
          if (input.removeMissingDramaMentionIds !== undefined) {
            if (Object.keys(input).some((key) => key !== 'removeMissingDramaMentionIds'
              && !Object.prototype.hasOwnProperty.call(targetProperties, key))) {
              const message = '清理失效资产引用不能混合其他节点编辑，请分开调用';
              return { status: 'error', summary: message, modelContent: message };
            }
            return removeMissingDramaMentions(context, targetIds, input.removeMissingDramaMentionIds);
          }
          if (input.repairMissingCloudOutputs === true) {
            if (Object.keys(input).some((key) => key !== 'repairMissingCloudOutputs'
              && !Object.prototype.hasOwnProperty.call(targetProperties, key))) {
              const message = '修复缺失产物缓存不能混合普通节点编辑，请分开调用';
              return { status: 'error', summary: message, modelContent: message };
            }
            return repairMissingCloudOutputs(context, targetIds);
          }
          requests.push({ input, targetIds });
        }
        const needsAssets = context.conversationId === `mcp-control-${context.projectId}` && requests.some((request) => {
          const text = request.input.promptEdit?.newText ?? request.input.prompt;
          return text !== undefined && hasActualNodeReference(text);
        });
        const globalAssets = needsAssets ? await readGlobalReferenceAssets(context) : undefined;
        const state = useAppStore.getState();
        const version = captureNodeVersionContext(context.projectId);
        const groups: PreparedNodeUpdate[] = [];
        for (const request of requests) {
          const targets: Node<BaseNodeData>[] = [];
          for (const id of request.targetIds) {
            const node = state.nodes.find((item) => item.id === id);
            if (!node) return reject('目标节点已变化，请重新查询；未修改任何节点');
            targets.push(node);
          }
          const prepared = await prepareNodeUpdate(context, request.input, targets, globalAssets, version);
          if ('status' in prepared) return prepared;
          groups.push(prepared);
        }
        const targetIds = groups.flatMap((group) => group.targetIds);
        const tracksOperation = Boolean(useAppStore.getState().agentTasks?.some((task) => task.id === context.taskId && task.mcpOperation));
        let operationItems: McpOperationItemReceipt[] = targetIds.map((nodeId) => ({ nodeId, status: 'not_started' }));
        const assertOperationOwner = () => {
          if (!useAppStore.getState().agentTasks?.some((task) => task.id === context.taskId && task.mcpOperation
            && !['paused', 'stopped', 'failed', 'completed'].includes(task.status))) throw new Error('MCP 操作任务已停止或移除');
        };
        const notStarted = async (): Promise<AgentToolExecutionResult> => {
          operationItems = operationItems.map((item) => ({ ...item, status: 'failed', errorCode: 'CANVAS_UPDATE_NOT_STARTED' }));
          await recordMcpOperationProgress(context.taskId, { phase: 'failed', items: operationItems, errorCode: 'CANVAS_UPDATE_NOT_STARTED' }).catch(() => undefined);
          return { status: 'error', summary: '画布更新未开始；操作回执或读取条件已变化，请只读核实',
            errorCode: 'CANVAS_UPDATE_NOT_STARTED', retryable: false, modelContent: JSON.stringify({ items: operationItems, retryable: false }) };
        };
        if (tracksOperation) {
          try {
            await recordMcpOperationProgress(context.taskId, { items: operationItems });
            assertOperationOwner();
            assertNodeVersionSnapshot(context, groups.flatMap((group) => group.targets), version);
          } catch { return notStarted(); }
        }
        const textFileTargets: TextFileTarget[] = groups.flatMap((group) => {
          const content = group.input.content;
          return content === undefined ? [] : group.targets.map((node) => ({ nodeId: node.id, nodeType: node.data.type,
            filePath: node.data.filePath, previousOutput: node.data.output, content }));
        });
        if (batch && isTauriEnv()) {
          const contents = new Map<string, string>();
          for (const target of textFileTargets) {
            if (!target.filePath || !TEXT_FILE_NODE_TYPES.has(target.nodeType)) continue;
            const fileKey = textFileSaveKey(target.filePath);
            if (contents.has(fileKey) && contents.get(fileKey) !== target.content) {
              return reject('同一个文本文件不能在同一批中写入不同正文；未修改任何节点');
            }
            contents.set(fileKey, target.content);
          }
        }
        const textFileRevision = state.getCurrentRevision();
        const textFileUpdates = isTauriEnv() && textFileTargets.some((target) => TEXT_FILE_NODE_TYPES.has(target.nodeType) && target.filePath)
          ? await prepareTextFileUpdates(context, textFileTargets, textFileRevision) : [];
        if (batch && textFileUpdates.some((update) => update.state === 'conflict' || update.state === 'read_failed')) {
          const summary = '文本文件基线读取失败或发生冲突，整批未修改；请核对后重新读取，不要自动重投写入';
          return { status: 'error', summary, retryable: false, errorCode: 'TEXT_FILE_PREPARE_FAILED',
            modelContent: JSON.stringify({ errorCode: 'TEXT_FILE_PREPARE_FAILED', operationStatus: 'not_executed', retryable: false,
              results: textFileUpdates.map((update) => ({ nodeId: update.nodeId, status: update.state })) }) };
        }
        if (textFileUpdates.length && !textFileTargetsFresh(context, textFileRevision, textFileTargets)) {
          throw new Error('项目、画布或文本文件关联已变化，请重新查询后操作');
        }
        assertCanvasRevision(context);
        if (!isCurrentProject(context.projectId)) throw new Error('目标项目当前未加载');
        if (context.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
        const current = useAppStore.getState();
        for (const group of groups) {
          if ((batch || group.input.expectedNodeHash !== undefined) && group.targets.some((node) => {
            const latest = current.nodes.find((item) => item.id === node.id);
            return !matchesCanvasNodeSnapshot(node, latest);
          })) throw new Error('目标节点已变化，请重新读取后修改；未修改任何节点');
          if (group.input.expectedNodeHash !== undefined) assertNodeVersionSnapshot(context, group.targets, version);
          if ([...group.promptEdits].some(([id, edit]) => {
            const node = current.nodes.find((item) => item.id === id);
            return !node || (node.data.prompt ?? '') !== edit.before;
          })) throw new Error('目标提示词已变化，请重新读取后修改；未修改任何节点');
        }
        if (tracksOperation) {
          try {
            operationItems = operationItems.map((item) => ({ ...item, status: 'started' }));
            await recordMcpOperationProgress(context.taskId, { items: operationItems });
            assertOperationOwner();
            assertNodeVersionSnapshot(context, groups.flatMap((group) => group.targets), version);
            if (textFileUpdates.length && !textFileTargetsFresh(context, textFileRevision, textFileTargets)) throw new Error('文本文件关联已变化');
          } catch { return notStarted(); }
        }
        const committedRevision = applyPreparedNodeUpdates(groups, batch);
        let textFilePersistence: Awaited<ReturnType<typeof persistTextFileUpdates>> | undefined;
        let receiptUnconfirmed = false;
        const fileProgress = async (nodeId: string, status: TextFilePersistenceStatus | 'saving') => {
          const item: McpOperationItemReceipt = status === 'saving' ? { nodeId, status: 'started', errorCode: 'CANVAS_APPLIED_FILE_PENDING' }
            : status === 'saved' || status === 'unchanged' ? { nodeId, status: 'succeeded' }
              : status === 'stale' ? { nodeId, status: 'unknown', errorCode: 'CANVAS_APPLIED_FILE_UNCONFIRMED' }
                : { nodeId, status: 'failed', errorCode: `CANVAS_APPLIED_FILE_${status.toUpperCase()}` };
          operationItems = operationItems.map((existing) => existing.nodeId === nodeId ? item : existing);
          await recordMcpOperationProgress(context.taskId, { items: operationItems, revisionAfter: committedRevision });
          if (status === 'saving') assertOperationOwner();
        };
        try {
          if (tracksOperation) {
            operationItems = operationItems.map((item) => {
              const file = textFileUpdates.find((update) => update.nodeId === item.nodeId);
              return !file || file.state === 'unchanged' ? { nodeId: item.nodeId, status: 'succeeded' }
                : file.state === 'write' ? { nodeId: item.nodeId, status: 'started', errorCode: 'CANVAS_APPLIED_FILE_PENDING' }
                  : { nodeId: item.nodeId, status: 'failed', errorCode: `CANVAS_APPLIED_FILE_${file.state.toUpperCase()}` };
            });
            await recordMcpOperationProgress(context.taskId, { items: operationItems, revisionAfter: committedRevision });
            assertOperationOwner();
            if (textFileUpdates.length && !textFileTargetsFresh(context, committedRevision, textFileTargets, true)) {
              throw new Error('画布提交后的原文件保存租约已失效');
            }
          }
          textFilePersistence = textFileUpdates.length
            ? await persistTextFileUpdates(context, textFileUpdates, textFileTargets, tracksOperation ? fileProgress : undefined) : undefined;
        } catch (error) {
          if (!tracksOperation) throw error;
          receiptUnconfirmed = true;
          operationItems = operationItems.map((item) => item.status === 'started'
            ? { ...item, status: 'unknown', errorCode: 'CANVAS_APPLIED_FILE_UNCONFIRMED' } : item);
        }
        const incomplete = receiptUnconfirmed || Boolean(textFilePersistence && (textFilePersistence.failedCount > 0 || textFilePersistence.stale));
        if (tracksOperation && incomplete) {
          await recordMcpOperationProgress(context.taskId, { phase: 'partial', items: operationItems, revisionAfter: committedRevision,
            errorCode: receiptUnconfirmed ? 'MCP_OPERATION_PROGRESS_UNCONFIRMED' : 'TEXT_FILE_SAVE_INCOMPLETE' }).catch(() => { receiptUnconfirmed = true; });
        }
        return {
          status: incomplete ? 'error' : 'success',
          summary: incomplete ? `已更新 ${targetIds.length} 个节点；文本文件保存未全部完成，画布草稿已保留，请检查冲突或文件权限`
            : `已更新 ${targetIds.length} 个节点`,
          ...(incomplete ? { retryable: false, errorCode: receiptUnconfirmed ? 'MCP_OPERATION_PROGRESS_UNCONFIRMED' : 'TEXT_FILE_SAVE_INCOMPLETE' } : {}),
          modelContent: JSON.stringify({ affectedNodeIds: targetIds, revision: committedRevision,
            ...(tracksOperation ? { items: operationItems, receiptUnconfirmed, retryable: false } : {}),
            ...(textFilePersistence ? { textFilePersistence } : {}) }),
          display: { changes: groups.flatMap((group) => buildUpdateChanges(group.input,
            useAppStore.getState().nodes.filter((node) => group.targetIds.includes(node.id)), group.beforeAudit)) },
        };
      },
    }),
    registerAgentTool<ConnectNodesInput>({
      id: 'canvas_connect_nodes',
      title: '连接画布节点',
      description: [
        '把 sourceIds 中的输出节点统一连到 targetId 接收节点；每次 1–50 个，整批校验后一次写入、一次撤销，重复节点和已有连线自动跳过。',
        '兼容旧参数 sourceId；sourceId 与 sourceIds 必须且只能提供一种。方向固定为输出节点 → 接收节点。',
        `端口固定为右出左入（sourceHandle=right、targetHandle=left），不会自动移动节点。连接前先用 canvas_query(detail=true) 检查位置：上游放左、下游放右，目标左边界应在源节点右边界之后并预留至少 ${AGENT_NODE_LAYOUT.columnGap} 画布单位；保持紧凑，不要把正常间距拉大。连接后检查返回的 layout.warning，确需调整时用 canvas_update_nodes。`,
        '连线会把上游节点的输出作为下游生成节点的参考输入，所以 targetId 必须是生成器节点：',
        'source-* 与 comment 只能作为输出节点。镜头制作节点不能反接回它所属的分镜表，成果通过镜头来源关联；批量连接只支持可见的普通节点，不含分组、笔记和插件节点。',
        '返回 connections 中每条线的实际端口、是否已连接和布局提醒，以及 createdCount、skippedCount；单源同时保留旧的 sourceId、layout 返回字段。',
      ].join(''),
      inputSchema: {
        type: 'object',
        required: ['targetId'],
        additionalProperties: false,
        properties: {
          sourceIds: { type: 'array', minItems: 1, maxItems: 50,
            items: { type: 'string', minLength: 1, maxLength: 120 },
            description: '要输出内容的节点 ID 列表，推荐使用；不能与 sourceId 同时传入。' },
          sourceId: { type: 'string', minLength: 1, maxLength: 120, description: '旧版单个输出节点 ID，与 sourceIds 二选一。' },
          targetId: { type: 'string', minLength: 1, maxLength: 120, description: '接收所有输出的一个生成节点 ID。' },
        },
      },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `连接 ${input.sourceIds?.length ?? 1} 个输出节点 → ${input.targetId}`,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        if ((input.sourceId !== undefined) === (input.sourceIds !== undefined)) {
          const message = 'sourceId 与 sourceIds 必须且只能提供一种';
          return { status: 'error', summary: message, modelContent: message };
        }
        const requested = input.sourceIds ?? [input.sourceId!];
        if (requested.length < 1 || requested.length > 50) {
          const message = '每次请提供 1 到 50 个输出节点';
          return { status: 'error', summary: message, modelContent: message };
        }
        const sourceIds = [...new Set(requested)];
        const store = useAppStore.getState();
        const sources = sourceIds.map((id) => store.nodes.find((node) => node.id === id));
        const targetNode = store.nodes.find((node) => node.id === input.targetId);
        if (sources.some((node) => !node) || !targetNode) {
          return { status: 'error', summary: '源节点或目标节点不存在', modelContent: '源节点或目标节点不存在' };
        }
        if (sourceIds.includes(input.targetId)) {
          return { status: 'error', summary: '不能连接节点自身', modelContent: '不能连接节点自身' };
        }
        // 素材节点没有输入，连进去的线永远不会被读取，多半是模型把两端写反了
        if (isSourceOnlyNode(targetNode)) {
          const message = `目标节点「${targetNode.data.label}」是素材节点，只能作为输出节点；请核对输出节点列表与接收节点是否写反`;
          return { status: 'error', summary: message, modelContent: message };
        }
        if (targetNode.data.type === 'ai-shotlist' && sources.some((node) =>
          node!.data.shotlistProductionSource?.nodeId === input.targetId)) {
          const message = '镜头制作节点不能反接回它所属的分镜表，视频与配音成果通过镜头来源关联；导演台使用分镜表 → 导演台';
          return { status: 'error', summary: message, modelContent: message };
        }
        if (sourceIds.length > 1 && [...sources, targetNode].some((node) => !isBatchConnectableNode(node!)
          || (node!.parentId && store.nodes.find((parent) => parent.id === node!.parentId)?.data.groupCollapsed))) {
          const message = '批量连接只支持可见的普通节点，请先展开分组并核对节点类型';
          return { status: 'error', summary: message, modelContent: message };
        }
        const connections = sourceIds.map((sourceId) => {
          const existing = store.edges.find((edge) => edge.source === sourceId && edge.target === input.targetId);
          return {
            sourceId, targetId: input.targetId, alreadyConnected: !!existing,
            sourceHandle: existing ? existing.sourceHandle ?? null : 'right',
            targetHandle: existing ? existing.targetHandle ?? null : 'left',
            layout: describeConnectionLayout(sourceId, input.targetId, store.nodes),
          };
        });
        const pending = connections.filter((connection) => !connection.alreadyConnected);
        if (pending.length) {
          if (sourceIds.length > 1) store.connectSelectedNodes(sourceIds, input.targetId, context.projectId);
          else store.onConnect({ source: sourceIds[0], target: input.targetId, sourceHandle: 'right', targetHandle: 'left' });
          // Store 可能拒绝失效的连接，先核对结果再报告成功。
          if (pending.some((connection) => !useAppStore.getState().edges.some((edge) =>
            edge.source === connection.sourceId && edge.target === input.targetId))) {
            return { status: 'error', summary: '连接未写入，请重新读取当前项目与节点', modelContent: '连接未写入，请重新读取当前项目与节点' };
          }
          useAppStore.getState().incrementRevision();
        }
        const needsLayout = connections.some((connection) => connection.layout?.warning);
        return {
          status: 'success',
          summary: `${pending.length ? `已创建 ${pending.length} 条连线` : '节点已经连接'}${needsLayout ? '，但布局需调整' : ''}`,
          modelContent: JSON.stringify({
            ...(connections.length === 1 ? connections[0] : {}),
            sourceIds, targetId: input.targetId, connections,
            createdCount: pending.length, skippedCount: requested.length - pending.length,
            revision: useAppStore.getState().getCurrentRevision(),
          }),
        };
      },
    }),
    registerAgentTool<DisconnectNodesInput>({
      id: 'canvas_disconnect_nodes',
      title: '断开画布连线',
      description: '删除连线。同时给出 sourceId 和 targetId 时只删这一条；只给一个时删除该节点作为该端的所有连线。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceId: { type: 'string', minLength: 1, maxLength: 120 },
          targetId: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `断开连线 ${input.sourceId ?? '*'} → ${input.targetId ?? '*'}`,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        // 两端都不给会删掉整张图的连线，必须拒绝
        if (!input.sourceId && !input.targetId) {
          const message = '必须至少提供 sourceId 或 targetId';
          return { status: 'error', summary: message, modelContent: message };
        }
        const store = useAppStore.getState();
        const matched = store.edges.filter((edge) => (
          (input.sourceId ? edge.source === input.sourceId : true)
          && (input.targetId ? edge.target === input.targetId : true)
        ));
        if (matched.length === 0) {
          return { status: 'error', summary: '没有找到匹配的连线', modelContent: '没有找到匹配的连线' };
        }
        store.onEdgesChange(matched.map((edge) => ({ type: 'remove' as const, id: edge.id })));
        useAppStore.getState().incrementRevision();
        return {
          status: 'success',
          summary: `已断开 ${matched.length} 条连线`,
          modelContent: JSON.stringify({
            removedEdgeIds: matched.map((edge) => edge.id),
            revision: useAppStore.getState().getCurrentRevision(),
          }),
        };
      },
    }),
    registerAgentTool<NodeTargetInput>({
      id: 'canvas_group_nodes',
      title: '组合画布节点',
      description: '把两个或更多匹配节点放入一个画布分组。',
      inputSchema: {
        type: 'object',
        properties: targetProperties,
        additionalProperties: false,
      },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `组合 ${resolveTargetIds(input).length} 个节点`,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const targetIds = resolveTargetIds(input);
        if (targetIds.length < 2) {
          return { status: 'error', summary: '分组至少需要两个节点', modelContent: '分组至少需要两个节点' };
        }
        const store = useAppStore.getState();
        store.setSelectedNodeIds(targetIds);
        store.groupSelectedNodes();
        useAppStore.getState().incrementRevision();
        return {
          status: 'success',
          summary: `已组合 ${targetIds.length} 个节点`,
          modelContent: JSON.stringify({
            affectedNodeIds: targetIds,
            revision: useAppStore.getState().getCurrentRevision(),
          }),
        };
      },
    }),
    registerAgentTool<NodeTargetInput>({
      id: 'canvas_ungroup_nodes',
      title: '解散画布分组',
      description: '解散匹配节点所在的分组，节点本身保留在画布上。',
      inputSchema: {
        type: 'object',
        properties: targetProperties,
        additionalProperties: false,
      },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `解散 ${resolveTargetIds(input).length} 个节点所在的分组`,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const targetIds = resolveTargetIds(input);
        if (targetIds.length === 0) {
          return { status: 'error', summary: '没有找到匹配节点', modelContent: '没有找到匹配节点' };
        }
        const store = useAppStore.getState();
        const groupCount = new Set(
          store.nodes
            .filter((node) => targetIds.includes(node.id))
            .map((node) => node.parentId ?? (node.data.groupId as string | undefined))
            .filter(Boolean),
        ).size;
        if (groupCount === 0) {
          return { status: 'error', summary: '匹配节点不属于任何分组', modelContent: '匹配节点不属于任何分组' };
        }
        store.setSelectedNodeIds(targetIds);
        store.ungroupSelectedNodes();
        useAppStore.getState().incrementRevision();
        return {
          status: 'success',
          summary: `已解散 ${groupCount} 个分组`,
          modelContent: JSON.stringify({
            affectedNodeIds: targetIds,
            revision: useAppStore.getState().getCurrentRevision(),
          }),
        };
      },
    }),
    registerAgentTool<NodeTargetInput>({
      id: 'canvas_run_nodes',
      title: '运行画布节点',
      description: [
        `按节点自身的提示词、模型和连线输入运行生成，一次最多 ${MAX_RUN_NODES} 个节点，串行执行。`,
        '这是真实的付费模型调用；Plan 模式拒绝，B 协作模式由 Policy 请求确认，C 自主模式与 MCP 会话直接执行。只想改参数不生成时用 canvas_update_nodes。',
        '正在生成中的节点会被跳过。新结构画布可通过 MCP 运行，调用时可带 operationKey 保留逐项回执。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: targetProperties,
        additionalProperties: false,
      },
      effect: 'media_generation',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `运行 ${resolveTargetIds(input).length} 个画布节点`,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const targetIds = resolveTargetIds(input);
        if (targetIds.length === 0) {
          return { status: 'error', summary: '没有找到匹配节点', modelContent: '没有找到匹配节点' };
        }
        if (targetIds.length > MAX_RUN_NODES) {
          const message = `一次最多运行 ${MAX_RUN_NODES} 个节点，当前匹配 ${targetIds.length} 个`;
          return { status: 'error', summary: message, modelContent: message };
        }
        const storyboardCount = useAppStore.getState().nodes.filter((node) => (
          targetIds.includes(node.id) && node.data.type === 'ai-storyboard'
        )).length;
        if (storyboardCount > 0) {
          const message = `宫格分镜是已有图片的裁切结果，不能运行生成（${storyboardCount} 个无效节点）`;
          return { status: 'error', summary: message, modelContent: message };
        }
        const initial = useAppStore.getState();
        const nativeContext = initial.projectExecutionContext?.modelGeneration === 1 ? initial.projectExecutionContext : undefined;
        const isTargetCanvas = (state: typeof initial) => state.currentProjectId === context.projectId
          && (!nativeContext || isProjectExpectedContextCurrent(nativeContext, state, { checkCanvasRevision: false }));
        const settings = initial.projects.find((project) => project.id === context.projectId)?.settings;
        const inputData = new Map(initial.nodes.filter((node) => targetIds.includes(node.id)).map((node) => [node.id, node.data]));
        const inputs = new Map(initial.nodes.filter((node) => targetIds.includes(node.id))
          .map((node) => [node.id, generationInputSnapshot(node.data, settings)]));
        const results: Array<{ nodeId: string; status: string; message?: string }> = [];
        const tracksOperation = Boolean(initial.agentTasks?.some((task) => task.id === context.taskId && task.mcpOperation));
        let operationItems: McpOperationItemReceipt[] = targetIds.map((nodeId) => ({ nodeId, status: 'not_started' }));
        let activeNodeId: string | undefined;
        let enteredGeneration = false;
        let operationRevision: number | undefined;
        const updateItem = (nodeId: string, status: McpOperationItemReceipt['status'], errorCode?: string) => {
          operationItems = operationItems.map((item) => item.nodeId === nodeId
            ? { nodeId, status, ...(errorCode ? { errorCode } : {}) } : item);
        };
        const assertOperationOwner = () => {
          if (!useAppStore.getState().agentTasks?.some((task) => task.id === context.taskId && task.mcpOperation
            && !['paused', 'stopped', 'failed', 'completed'].includes(task.status))) throw new Error('MCP 操作任务已停止或移除');
        };
        try {
          if (nativeContext) {
            const baseRevision = initial.getCurrentRevision();
            const assertPreparing = () => {
              const live = useAppStore.getState();
              if (context.signal.aborted || !isTargetCanvas(live) || live.getCurrentRevision() !== baseRevision) {
                throw new Error('项目或运行输入已变化，未提交生成');
              }
              assertCanvasRevision(context);
              if (tracksOperation) assertOperationOwner();
              const currentSettings = live.projects.find((project) => project.id === context.projectId)?.settings;
              for (const [nodeId, expected] of inputs) {
                const node = live.nodes.find((entry) => entry.id === nodeId);
                if (!node || generationInputSnapshot(node.data, currentSettings) !== expected) throw new Error('节点生成输入已变化，未提交生成');
              }
            };
            for (const nodeId of targetIds) {
              assertPreparing();
              const live = useAppStore.getState(), node = live.nodes.find((entry) => entry.id === nodeId);
              if (!node || node.data.status === 'loading' || !['ai-image', 'ai-animation', 'ai-panorama', 'ai-video', 'ai-audio', 'source-image', 'source-video', 'source-audio'].includes(node.data.type)) continue;
              const normalized = await live.normalizeNativeMediaGenerationInputs(nodeId);
              // 只用受控回补证明更新授权快照；异步期间其他真实输入编辑仍与原快照比较。
              for (const [id, patch] of normalized.nodePatches) {
                const previous = inputData.get(id);
                if (!previous) continue;
                const next = { ...previous, ...patch };
                inputData.set(id, next); inputs.set(id, generationInputSnapshot(next, settings));
              }
              assertPreparing();
            }
          }
          if (tracksOperation) {
            await recordMcpOperationProgress(context.taskId, { items: operationItems });
            assertOperationOwner();
            assertCanvasRevision(context);
          }
          for (const nodeId of targetIds) {
            activeNodeId = nodeId;
            enteredGeneration = false;
            if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const node = useAppStore.getState().nodes.find((candidate) => candidate.id === nodeId);
            if (!node) {
              results.push({ nodeId, status: 'missing' });
              if (tracksOperation) {
                updateItem(nodeId, 'failed', 'CANVAS_NODE_MISSING');
                await recordMcpOperationProgress(context.taskId, { items: operationItems });
              }
              continue;
            }
            if (node.data.status === 'loading') {
              results.push({ nodeId, status: 'skipped', message: '节点正在生成中' });
              if (tracksOperation) {
                updateItem(nodeId, 'not_started', 'CANVAS_NODE_BUSY');
                await recordMcpOperationProgress(context.taskId, { items: operationItems });
              }
              continue;
            }
            // 校验当前模型，而非仅信任此前配置过参数时的模型；本地及云工作流继续使用各自参数合同。
            const data = node.data;
            const kind = getProjectModelKind(data.type);
            const projectModel = kind && useAppStore.getState().projects.find((project) => project.id === context.projectId)
              ?.settings?.defaultModels?.[kind];
            const provider = parseProjectModelRef((data.model || projectModel) ?? undefined)?.provider ?? data.provider;
            const usesWorkflow = Boolean(data.workflowId) || ['comfyui', 'runninghub', 'runninghubwf', 'workflow-api'].includes(provider ?? '');
            const parameters = data.type === 'ai-image' ? { imageQuality: data.imageQuality, imageBackground: data.imageBackground,
              ...pickImageOutputParameters(data) }
              : data.type === 'ai-video' ? { videoFps: data.videoFps, generateAudio: data.generateAudio,
                ...(data.seedanceDuration !== undefined && data.seedanceDuration < 0 ? { videoDuration: data.seedanceDuration } : {}) }
                : undefined;
            const issue = !usesWorkflow && parameters ? mediaSettingsIssue(data.type, parameters, data) : undefined;
            if (issue) {
              results.push({ nodeId, status: 'failed', message: issue });
              if (tracksOperation) {
                updateItem(nodeId, 'failed', 'CANVAS_NODE_PARAMETER_INVALID');
                await recordMcpOperationProgress(context.taskId, { items: operationItems });
              }
              continue;
            }
            let leaseInvalidated = false;
            const lease: GenerationLease = { signal: context.signal, assertFresh: () => {
              if (context.signal.aborted) { leaseInvalidated = true; throw new DOMException('请求已取消', 'AbortError'); }
              if (tracksOperation) {
                try { assertOperationOwner(); } catch (error) { leaseInvalidated = true; throw error; }
              }
              const current = useAppStore.getState();
              const live = current.nodes.find((candidate) => candidate.id === nodeId);
              const currentSettings = current.projects.find((project) => project.id === context.projectId)?.settings;
              if (!isTargetCanvas(current) || !live
                || generationInputSnapshot(live.data, currentSettings) !== inputs.get(nodeId)) {
                leaseInvalidated = true;
                throw new Error('项目或节点生成输入已变化，请重新查询后运行');
              }
            } };
            // 生成自身会创建批次节点并增加 revision，不能用整次调用的旧 revision 取消它。
            await lease.assertFresh();
            if (tracksOperation) {
              updateItem(nodeId, 'started');
              await recordMcpOperationProgress(context.taskId, { items: operationItems });
              await lease.assertFresh();
            }
            enteredGeneration = true;
            const result = await executeGeneration(nodeId, undefined, undefined, undefined, lease);
            if (tracksOperation) {
              // 已交付的结果先登记本项目revision；不能被随后的journal等待或取消漏记。
              const current = useAppStore.getState();
              const sameCanvas = isTargetCanvas(current);
              if (sameCanvas) operationRevision = current.incrementRevision();
              const unconfirmed = !result.success && (result.recovery !== undefined || leaseInvalidated || context.signal.aborted || !sameCanvas
                || getPendingTasksForProject(context.projectId).some((task) => task.nodeId === nodeId));
              updateItem(nodeId, result.success ? 'succeeded' : unconfirmed ? 'unknown' : 'failed',
                result.success ? undefined : unconfirmed ? 'CANVAS_NODE_RESULT_UNCONFIRMED' : 'CANVAS_NODE_GENERATION_FAILED');
              results.push({ nodeId, status: result.success ? 'success' : 'failed', message: result.message });
              await recordMcpOperationProgress(context.taskId, { items: operationItems,
                ...(operationRevision !== undefined ? { revisionAfter: operationRevision } : {}) });
              if (leaseInvalidated) throw new Error('节点原生成租约已撤销，请核对原任务');
            }
            if (context.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
            // 生成期间用户可能切走项目，后续节点不能再往这张画布写
            if (!isTargetCanvas(useAppStore.getState())) {
              if (tracksOperation) throw new Error('生成期间项目已切换');
              results.push({ nodeId, status: 'aborted', message: '生成期间项目已切换' });
              break;
            }
            if (!tracksOperation) useAppStore.getState().incrementRevision();
            if (!tracksOperation) results.push({
              nodeId,
              status: result.success ? 'success' : 'failed',
              message: result.message,
            });
          }
        } catch (error) {
          if (!tracksOperation) throw error;
          const activeItem = operationItems.find((item) => item.nodeId === activeNodeId);
          if (activeNodeId && activeItem?.status === 'started') updateItem(activeNodeId, enteredGeneration ? 'unknown' : 'failed',
            enteredGeneration ? 'CANVAS_NODE_RESULT_UNCONFIRMED' : 'CANVAS_NODE_NOT_STARTED');
          const succeeded = operationItems.filter((item) => item.status === 'succeeded').length;
          await recordMcpOperationProgress(context.taskId, { items: operationItems,
            ...(operationRevision !== undefined ? { revisionAfter: operationRevision } : {}),
            phase: succeeded > 0 ? 'partial' : operationItems.some((item) => item.status === 'unknown') ? 'unknown' : 'failed',
            errorCode: 'CANVAS_RUN_INTERRUPTED' }).catch(() => undefined);
          return { status: 'error', summary: `已完成 ${succeeded}/${targetIds.length} 个节点，批次已停止；请只读核实原任务，不要重投`,
            errorCode: 'CANVAS_RUN_INTERRUPTED', retryable: false,
            modelContent: JSON.stringify({ projectId: context.projectId, results, items: operationItems, retryable: false,
              ...(operationRevision !== undefined ? { revision: operationRevision } : {}) }) };
        }
        const succeeded = results.filter((item) => item.status === 'success').length;
        return {
          status: succeeded > 0 ? 'success' : 'error',
          summary: `已运行 ${succeeded}/${targetIds.length} 个节点`,
          modelContent: JSON.stringify({
            results,
            ...(tracksOperation ? { items: operationItems, retryable: false } : {}),
            ...(tracksOperation ? { projectId: context.projectId,
              ...(operationRevision !== undefined ? { revision: operationRevision } : {}) }
              : { revision: useAppStore.getState().getCurrentRevision() }),
          }),
        };
      },
    }),
    registerAgentTool<{ nodeId: string }>({
      id: 'canvas_duplicate_node', title: '复制画布节点', description: '复制一个普通节点或画布笔记；分组节点不可复制。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['nodeId'], additionalProperties: false, properties: { nodeId: { type: 'string', minLength: 1, maxLength: 160 } } }, authorize: authorizeCurrentProject,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const store = useAppStore.getState();
        const node = store.nodes.find((item) => item.id === input.nodeId);
        if (!node || node.type === 'group') return { status: 'error', summary: '节点不存在或分组节点不可复制', modelContent: '节点不存在或分组节点不可复制' };
        const cloneId = node.type === 'canvas-note'
          ? await store.duplicateCanvasNote(node.id)
          : await store.duplicateNode(node.id);
        if (!cloneId) return { status: 'error', summary: '节点复制失败', modelContent: '节点复制失败' };
        useAppStore.getState().incrementRevision();
        return { status: 'success', summary: `已复制节点“${node.data.label}”`, modelContent: JSON.stringify({ sourceNodeId: node.id, cloneNodeId: cloneId, revision: useAppStore.getState().getCurrentRevision() }) };
      },
    }),
    registerAgentTool<{ nodeId: string; text?: string; width?: number; height?: number; opacity?: number; strokeColor?: string; backgroundColor?: string; fontSize?: 16 | 20 | 28 | 36; textAlign?: 'left' | 'center' | 'right' }>({
      id: 'canvas_update_note', title: '更新画布笔记', description: '更新画布笔记的文字、尺寸和基础样式。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['nodeId'], additionalProperties: false, properties: {
        nodeId: { type: 'string', minLength: 1, maxLength: 160 }, text: { type: 'string', maxLength: 20_000 }, width: { type: 'number', minimum: 20, maximum: 4000 }, height: { type: 'number', minimum: 20, maximum: 4000 }, opacity: { type: 'number', minimum: 0, maximum: 100 }, strokeColor: { type: 'string', minLength: 1, maxLength: 80 }, backgroundColor: { type: 'string', minLength: 1, maxLength: 80 }, fontSize: { type: 'number', enum: [16, 20, 28, 36] }, textAlign: { type: 'string', enum: ['left', 'center', 'right'] },
      } }, authorize: authorizeCurrentProject,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const { nodeId, text, width, height, ...style } = input;
        const changed = useAppStore.getState().updateCanvasNote(nodeId, { text, width, height, style });
        if (!changed) return { status: 'error', summary: '画布笔记不存在', modelContent: '画布笔记不存在' };
        useAppStore.getState().incrementRevision();
        return { status: 'success', summary: '已更新画布笔记', modelContent: JSON.stringify({ nodeId, revision: useAppStore.getState().getCurrentRevision() }) };
      },
    }),
    registerAgentTool<{ nodeId: string; direction: 'back' | 'backward' | 'forward' | 'front' }>({
      id: 'canvas_move_note_layer', title: '调整画布笔记图层', description: '将画布笔记后移、前移、置底或置顶。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['nodeId', 'direction'], additionalProperties: false, properties: { nodeId: { type: 'string', minLength: 1, maxLength: 160 }, direction: { type: 'string', enum: ['back', 'backward', 'forward', 'front'] } } }, authorize: authorizeCurrentProject,
      execute: async (context, input) => { assertCanvasRevision(context); const moved = useAppStore.getState().moveCanvasNoteLayer(input.nodeId, input.direction); if (!moved) return { status: 'error', summary: '画布笔记不存在或已在目标图层边界', modelContent: '画布笔记不存在或已在目标图层边界' }; useAppStore.getState().incrementRevision(); return { status: 'success', summary: '已调整画布笔记图层', modelContent: JSON.stringify({ nodeId: input.nodeId, direction: input.direction, revision: useAppStore.getState().getCurrentRevision() }) }; },
    }),
    registerAgentTool<{ nodeId: string }>({
      id: 'canvas_convert_image_kind', title: '转换图片节点形态', description: '在图片节点与图片画布笔记之间转换；有连线的普通图片节点不会转换。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['nodeId'], additionalProperties: false, properties: { nodeId: { type: 'string', minLength: 1, maxLength: 160 } } }, authorize: authorizeCurrentProject,
      execute: async (context, input) => { assertCanvasRevision(context); const result = useAppStore.getState().convertImageNodeKind(input.nodeId); if (!result || result === 'connected') return { status: 'error', summary: result === 'connected' ? '图片节点有连线，不能转换为画布笔记' : '节点不是可转换的图片节点', modelContent: result === 'connected' ? '图片节点有连线，不能转换为画布笔记' : '节点不是可转换的图片节点' }; useAppStore.getState().incrementRevision(); return { status: 'success', summary: `已${result === 'to-note' ? '转换为图片笔记' : '转换为图片节点'}`, modelContent: JSON.stringify({ nodeId: input.nodeId, result, revision: useAppStore.getState().getCurrentRevision() }) }; },
    }),
    registerAgentTool<{ groupId: string; name: string }>({
      id: 'canvas_rename_group', title: '重命名画布分组', description: '重命名一个现有画布分组。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['groupId', 'name'], additionalProperties: false, properties: { groupId: { type: 'string', minLength: 1, maxLength: 160 }, name: { type: 'string', minLength: 1, maxLength: 120 } } }, authorize: authorizeCurrentProject,
      execute: async (context, input) => { assertCanvasRevision(context); const group = useAppStore.getState().groups.find((item) => item.id === input.groupId); if (!group) return { status: 'error', summary: '画布分组不存在', modelContent: '画布分组不存在' }; useAppStore.getState().renameGroup(group.id, input.name.trim()); useAppStore.getState().incrementRevision(); return { status: 'success', summary: `已重命名分组为“${input.name.trim()}”`, modelContent: JSON.stringify({ groupId: group.id, name: input.name.trim(), revision: useAppStore.getState().getCurrentRevision() }) }; },
    }),
    registerAgentTool<{ storyboardId: string; cellIndex: number; sourceNodeId: string }>({
      id: 'canvas_fill_storyboard_cell', title: '填充分镜宫格', description: '把已提取的图片节点填入分镜宫格空位；源图片节点按既有语义从画布移除。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['storyboardId', 'cellIndex', 'sourceNodeId'], additionalProperties: false, properties: { storyboardId: { type: 'string', minLength: 1, maxLength: 160 }, cellIndex: { type: 'integer', minimum: 0, maximum: 399 }, sourceNodeId: { type: 'string', minLength: 1, maxLength: 160 } } }, authorize: authorizeCurrentProject,
      execute: async (context, input) => { assertCanvasRevision(context); const before = useAppStore.getState().nodes.some((item) => item.id === input.sourceNodeId); useAppStore.getState().fillStoryboardCell(input.storyboardId, input.cellIndex, input.sourceNodeId); const consumed = before && !useAppStore.getState().nodes.some((item) => item.id === input.sourceNodeId); if (!consumed) return { status: 'error', summary: '宫格、来源图片或目标空位无效', modelContent: '宫格、来源图片或目标空位无效' }; useAppStore.getState().incrementRevision(); return { status: 'success', summary: '已填充分镜宫格', modelContent: JSON.stringify({ storyboardId: input.storyboardId, cellIndex: input.cellIndex, sourceNodeId: input.sourceNodeId, revision: useAppStore.getState().getCurrentRevision() }) }; },
    }),
    registerAgentTool<{ shotlistId: string; rowId: string; sourceNodeId: string }>({
      id: 'canvas_bind_shotlist_frame', title: '绑定镜头表媒体', description: '把图片节点绑定到指定行的画面列，把就绪视频节点绑定到独立的生成视频列；视频不覆盖参考画面。保留源节点稳定引用，无需反接到分镜表。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['shotlistId', 'rowId', 'sourceNodeId'], additionalProperties: false, properties: { shotlistId: { type: 'string', minLength: 1, maxLength: 160 }, rowId: { type: 'string', minLength: 1, maxLength: 160 }, sourceNodeId: { type: 'string', minLength: 1, maxLength: 160 } } }, authorize: authorizeCurrentProject,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const store = useAppStore.getState();
        const source = store.nodes.find((item) => item.id === input.sourceNodeId);
        const target = source && ['ai-video', 'source-video'].includes(source.data.type) ? 'video' : 'frame';
        const before = JSON.stringify(store.nodes.find((item) => item.id === input.shotlistId)?.data.shotlistRows ?? []);
        let bound: boolean | undefined;
        if (target === 'video') bound = store.bindShotlistVideo(input.shotlistId, input.rowId, input.sourceNodeId);
        else store.bindShotlistFrame(input.shotlistId, input.rowId, input.sourceNodeId);
        const after = JSON.stringify(useAppStore.getState().nodes.find((item) => item.id === input.shotlistId)?.data.shotlistRows ?? []);
        if (bound === false || (target === 'frame' && before === after)) {
          return { status: 'error', summary: '镜头表、行或来源媒体无效', modelContent: '镜头表、行或来源媒体无效' };
        }
        if (before !== after) useAppStore.getState().incrementRevision();
        return { status: 'success', summary: target === 'video' ? '已绑定镜头表生成视频' : '已绑定镜头表画面',
          modelContent: JSON.stringify({ ...input, target, reused: before === after, revision: useAppStore.getState().getCurrentRevision() }) };
      },
    }),
    registerAgentTool<NodeTargetInput>({
      id: 'canvas_delete_nodes',
      title: '删除画布节点',
      description: '删除符合条件的画布节点；删除可通过画布撤销恢复，不是永久删除项目文件。',
      inputSchema: {
        type: 'object',
        properties: targetProperties,
        additionalProperties: false,
      },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `删除 ${resolveTargetIds(input).length} 个节点`,
      execute: async (context, input) => {
        const targetIds = resolveTargetIds(input);
        if (targetIds.length === 0) {
          return { status: 'error', summary: '没有找到待删除节点', modelContent: '没有找到待删除节点' };
        }
        return executeCanvasCommand('deleteNodes', targetIds, context, '删除画布节点');
      },
    }),
    registerAgentTool<Record<string, never>>({
      id: 'canvas_undo',
      title: '撤销画布操作',
      description: '撤销最近一次可撤销的画布操作。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: () => '撤销画布操作',
      execute: async (context) => executeCanvasCommand('undo', [], context, '撤销画布操作'),
    }),
    registerAgentTool<Record<string, never>>({
      id: 'canvas_redo',
      title: '重做画布操作',
      description: '恢复最近一次被撤销的画布操作。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: () => '重做画布操作',
      execute: async (context) => executeCanvasCommand('redo', [], context, '重做画布操作'),
    }),
  ];
}
