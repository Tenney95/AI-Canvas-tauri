import type { NodeType } from '../../types';
import type {
  InstalledPlugin,
  PluginCategory,
  PluginManifest,
  PluginNodeOutputMode,
  PluginPermission,
  PluginPlacement,
} from '../../types/plugin';

const PLUGIN_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/;
const TOOL_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_TOOLS = 64;
const MAX_FIELDS = 64;

const NODE_TYPES = new Set<NodeType>([
  'ai-text',
  'ai-image',
  'ai-video',
  'ai-audio',
  'ai-animation',
  'ai-panorama',
  'ai-markdown',
  'ai-storyboard',
  'ai-shotlist',
  'ai-director',
  'source-image',
  'source-video',
  'source-audio',
  'source-text',
  'canvas-note',
  'comment',
]);

const PERMISSIONS = new Set<PluginPermission>(['node.read', 'node.write']);
const OUTPUT_MODES = new Set<PluginNodeOutputMode>(['update-current', 'create-node']);
const CATEGORIES = new Set<PluginCategory>(['content', 'media', 'workflow', 'utility']);
const PLACEMENTS = new Set<PluginPlacement>(['node-context-menu']);
const FORBIDDEN_INPUT_FIELDS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'filePath',
  'relativePath',
  'directorCaptureFilePaths',
]);
const FORBIDDEN_OUTPUT_FIELDS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'type',
  'displayId',
  'filePath',
  'relativePath',
  'assetId',
  'artifactId',
  'role',
  'dramaAssetId',
  'dramaAssetKind',
  'characterLibraryLinks',
  'hiddenByCharacterLibrary',
  'directorInstanceId',
  'directorCaptureFilePaths',
]);

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string, maxLength = 160): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`);
  return value.trim().slice(0, maxLength);
}

function stringArray(value: unknown, label: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new Error(`${label} 必须包含 1-${maxItems} 项`);
  }
  return value.map((item, index) => nonEmptyString(item, `${label}[${index}]`, 128));
}

function parseManifest(value: unknown): PluginManifest {
  const root = objectValue(value, 'manifest');
  if (root.apiVersion !== 1) throw new Error('仅支持 apiVersion: 1');
  const id = nonEmptyString(root.id, '插件 id', 128);
  if (!PLUGIN_ID_RE.test(id)) throw new Error('插件 id 只能使用小写字母、数字、点、下划线和短横线');
  const entry = nonEmptyString(root.entry, 'entry', 32);
  if (entry !== 'main.js') throw new Error('首版插件入口必须是 main.js');

  const permissions = stringArray(root.permissions, 'permissions', 8);
  if (permissions.some((permission) => !PERMISSIONS.has(permission as PluginPermission))) {
    throw new Error('插件声明了不支持的权限');
  }
  const contributes = objectValue(root.contributes, 'contributes');
  if (!Array.isArray(contributes.nodeTools) || contributes.nodeTools.length === 0) {
    throw new Error('插件至少需要贡献一个节点工具');
  }
  if (contributes.nodeTools.length > MAX_TOOLS) throw new Error(`节点工具不能超过 ${MAX_TOOLS} 个`);

  const seenToolIds = new Set<string>();
  const nodeTools = contributes.nodeTools.map((rawTool, index) => {
    const tool = objectValue(rawTool, `nodeTools[${index}]`);
    const toolId = nonEmptyString(tool.id, `nodeTools[${index}].id`, 64);
    if (!TOOL_ID_RE.test(toolId)) throw new Error(`节点工具 id 无效: ${toolId}`);
    if (seenToolIds.has(toolId)) throw new Error(`节点工具 id 重复: ${toolId}`);
    seenToolIds.add(toolId);

    const nodeTypes = stringArray(tool.nodeTypes, `${toolId}.nodeTypes`, NODE_TYPES.size);
    if (nodeTypes.some((nodeType) => !NODE_TYPES.has(nodeType as NodeType))) {
      throw new Error(`${toolId} 包含不支持的节点类型`);
    }
    const inputFields = stringArray(tool.inputFields, `${toolId}.inputFields`, MAX_FIELDS);
    if (inputFields.some((field) => !FIELD_RE.test(field))) throw new Error(`${toolId} 包含无效输入字段`);
    if (inputFields.some((field) => FORBIDDEN_INPUT_FIELDS.has(field))) {
      throw new Error(`${toolId} 请求了不允许暴露给插件的本地字段`);
    }
    const placements = stringArray(tool.placements, `${toolId}.placements`, 4);
    if (placements.some((placement) => !PLACEMENTS.has(placement as PluginPlacement))) {
      throw new Error(`${toolId} 包含当前版本不支持的入口位置`);
    }

    const output = objectValue(tool.output, `${toolId}.output`);
    const mode = nonEmptyString(output.mode, `${toolId}.output.mode`, 32) as PluginNodeOutputMode;
    if (!OUTPUT_MODES.has(mode)) throw new Error(`${toolId} 的输出模式不受支持`);
    const fields = stringArray(output.fields, `${toolId}.output.fields`, MAX_FIELDS);
    if (fields.some((field) => !FIELD_RE.test(field))) throw new Error(`${toolId} 包含无效输出字段`);
    if (fields.some((field) => FORBIDDEN_OUTPUT_FIELDS.has(field))) {
      throw new Error(`${toolId} 请求修改受保护节点字段`);
    }
    const outputNodeType = output.nodeType === undefined
      ? undefined
      : nonEmptyString(output.nodeType, `${toolId}.output.nodeType`, 32) as NodeType;
    if (outputNodeType && !NODE_TYPES.has(outputNodeType)) throw new Error(`${toolId} 的输出节点类型不受支持`);

    return {
      id: toolId,
      title: nonEmptyString(tool.title, `${toolId}.title`, 80),
      description: typeof tool.description === 'string' ? tool.description.trim().slice(0, 240) : undefined,
      placements: [...new Set(placements)] as PluginPlacement[],
      nodeTypes: nodeTypes as NodeType[],
      inputFields,
      output: { mode, nodeType: outputNodeType, fields },
    };
  });

  if (nodeTools.some((tool) => tool.inputFields.length > 0) && !permissions.includes('node.read')) {
    throw new Error('读取节点输入的插件必须声明 node.read');
  }
  if (!permissions.includes('node.write')) throw new Error('节点工具插件必须声明 node.write');

  const category = nonEmptyString(root.category, '插件分类', 32) as PluginCategory;
  if (!CATEGORIES.has(category)) throw new Error('插件分类不受支持');
  const keywords = root.keywords === undefined ? undefined : stringArray(root.keywords, 'keywords', 12);

  return {
    apiVersion: 1,
    id,
    name: nonEmptyString(root.name, '插件名称', 80),
    version: nonEmptyString(root.version, '插件版本', 32),
    author: typeof root.author === 'string' ? root.author.trim().slice(0, 80) : undefined,
    description: typeof root.description === 'string' ? root.description.trim().slice(0, 240) : undefined,
    category,
    keywords,
    entry: 'main.js',
    permissions: [...new Set(permissions)] as PluginPermission[],
    contributes: { nodeTools },
  };
}

export function parsePluginBundle(manifestText: string, source: string): PluginManifest {
  if (new Blob([manifestText]).size > MAX_MANIFEST_BYTES) throw new Error('manifest.json 过大');
  if (new Blob([source]).size > MAX_SOURCE_BYTES) throw new Error('main.js 过大');
  if (!source.trim()) throw new Error('main.js 不能为空');
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch {
    throw new Error('manifest.json 不是有效 JSON');
  }
  return parseManifest(raw);
}

export function createInstalledPlugin(
  manifest: PluginManifest,
  source: string,
  previous?: InstalledPlugin,
): InstalledPlugin {
  const now = Date.now();
  return {
    id: manifest.id,
    manifest,
    source,
    enabled: previous?.enabled ?? true,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
  };
}
