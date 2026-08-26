import type { NodeType } from '../../types';
import type {
  InstalledPlugin,
  PluginCategory,
  PluginCustomNodeFieldManifest,
  PluginCustomNodeFieldType,
  PluginCustomNodeManifest,
  PluginDialogFieldType,
  PluginManifest,
  PluginNodePortType,
  PluginNodeOutputMode,
  PluginPermission,
  PluginPlacement,
  PluginRuntime,
  PluginToolDialogManifest,
} from '../../types/plugin';

const PLUGIN_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/;
const TOOL_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ICON_RE = /^[a-z0-9][a-z0-9-]{0,31}:[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_TOOLS = 64;
const MAX_NODES = 32;
const MAX_FIELDS = 64;
const MAX_DIALOG_FIELDS = 16;
const MAX_DIALOG_OPTIONS = 32;
const MAX_NODE_PORTS = 16;

export function normalizeGithubRepository(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('repository 必须是有效的 GitHub HTTPS 地址');
  }
  const parts = url.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean);
  if (
    url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== 'github.com'
    || url.username
    || url.password
    || url.search
    || url.hash
    || parts.length !== 2
    || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    throw new Error('repository 必须是 https://github.com/作者/仓库');
  }
  return `https://github.com/${parts[0]}/${parts[1]}`;
}

function optionalHttpsUrl(value: unknown, label: string): string | undefined {
  const raw = optionalString(value, label, 512);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${label} 必须是有效的 HTTPS 地址`);
  }
}

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

const PERMISSIONS = new Set<PluginPermission>([
  'node.read',
  'node.write',
  'models.read',
  'models.invoke',
  'files.read',
  'files.write',
]);
const OUTPUT_MODES = new Set<PluginNodeOutputMode>(['update-current', 'create-node']);
const CATEGORIES = new Set<PluginCategory>(['content', 'media', 'workflow', 'utility']);
const PLACEMENTS = new Set<PluginPlacement>(['node-context-menu', 'node-toolbar']);
const DIALOG_FIELD_TYPES = new Set<PluginDialogFieldType>(['text', 'textarea', 'number', 'select', 'boolean']);
const CUSTOM_NODE_FIELD_TYPES = new Set<PluginCustomNodeFieldType>([
  ...DIALOG_FIELD_TYPES,
  'model',
  'file',
]);
const PORT_TYPES = new Set<PluginNodePortType>(['text', 'image', 'video', 'audio', 'json']);
const MODEL_CATEGORIES = new Set(['text', 'image', 'video', 'audio']);
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
  'pluginId',
  'pluginNodeId',
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

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, label, maxLength);
}

function parseToolDialog(value: unknown, toolId: string): PluginToolDialogManifest {
  const dialog = objectValue(value, `${toolId}.dialog`);
  if (!Array.isArray(dialog.fields) || dialog.fields.length > MAX_DIALOG_FIELDS) {
    throw new Error(`${toolId}.dialog.fields 必须是数组且不能超过 ${MAX_DIALOG_FIELDS} 项`);
  }
  const seenFieldIds = new Set<string>();
  const fields = dialog.fields.map((rawField, index) => {
    const field = objectValue(rawField, `${toolId}.dialog.fields[${index}]`);
    const id = nonEmptyString(field.id, `${toolId}.dialog.fields[${index}].id`, 64);
    if (!FIELD_RE.test(id)) throw new Error(`${toolId} 的弹窗字段 id 无效: ${id}`);
    if (seenFieldIds.has(id)) throw new Error(`${toolId} 的弹窗字段 id 重复: ${id}`);
    seenFieldIds.add(id);
    const type = nonEmptyString(field.type, `${toolId}.${id}.type`, 16) as PluginDialogFieldType;
    if (!DIALOG_FIELD_TYPES.has(type)) throw new Error(`${toolId}.${id} 使用了不支持的弹窗字段类型`);
    if (field.required !== undefined && typeof field.required !== 'boolean') {
      throw new Error(`${toolId}.${id}.required 必须是布尔值`);
    }

    let options: Array<{ label: string; value: string }> | undefined;
    if (type === 'select') {
      if (!Array.isArray(field.options) || field.options.length === 0 || field.options.length > MAX_DIALOG_OPTIONS) {
        throw new Error(`${toolId}.${id}.options 必须包含 1-${MAX_DIALOG_OPTIONS} 项`);
      }
      const seenValues = new Set<string>();
      options = field.options.map((rawOption, optionIndex) => {
        const option = objectValue(rawOption, `${toolId}.${id}.options[${optionIndex}]`);
        const value = nonEmptyString(option.value, `${toolId}.${id}.options[${optionIndex}].value`, 128);
        if (seenValues.has(value)) throw new Error(`${toolId}.${id} 的选项值重复: ${value}`);
        seenValues.add(value);
        return {
          label: nonEmptyString(option.label, `${toolId}.${id}.options[${optionIndex}].label`, 80),
          value,
        };
      });
    } else if (field.options !== undefined) {
      throw new Error(`${toolId}.${id} 只有 select 字段可以配置 options`);
    }

    let defaultValue: string | number | boolean | undefined;
    if (field.defaultValue !== undefined) {
      if ((type === 'text' || type === 'textarea' || type === 'select') && typeof field.defaultValue === 'string') {
        defaultValue = field.defaultValue.slice(0, 4096);
      } else if (type === 'number' && typeof field.defaultValue === 'number' && Number.isFinite(field.defaultValue)) {
        defaultValue = field.defaultValue;
      } else if (type === 'boolean' && typeof field.defaultValue === 'boolean') {
        defaultValue = field.defaultValue;
      } else {
        throw new Error(`${toolId}.${id}.defaultValue 与字段类型不匹配`);
      }
      if (type === 'select' && !options?.some((option) => option.value === defaultValue)) {
        throw new Error(`${toolId}.${id}.defaultValue 不在选项中`);
      }
    }

    return {
      id,
      label: nonEmptyString(field.label, `${toolId}.${id}.label`, 80),
      type,
      description: optionalString(field.description, `${toolId}.${id}.description`, 160),
      placeholder: optionalString(field.placeholder, `${toolId}.${id}.placeholder`, 120),
      required: field.required as boolean | undefined,
      defaultValue,
      options,
    };
  });

  return {
    title: optionalString(dialog.title, `${toolId}.dialog.title`, 80),
    description: optionalString(dialog.description, `${toolId}.dialog.description`, 240),
    submitLabel: optionalString(dialog.submitLabel, `${toolId}.dialog.submitLabel`, 40),
    fields,
  };
}

function parseCustomNodeField(value: unknown, nodeId: string, index: number): PluginCustomNodeFieldManifest {
  const field = objectValue(value, `${nodeId}.fields[${index}]`);
  const id = nonEmptyString(field.id, `${nodeId}.fields[${index}].id`, 64);
  if (!FIELD_RE.test(id)) throw new Error(`${nodeId} 的字段 id 无效: ${id}`);
  const type = nonEmptyString(field.type, `${nodeId}.${id}.type`, 16) as PluginCustomNodeFieldType;
  if (!CUSTOM_NODE_FIELD_TYPES.has(type)) throw new Error(`${nodeId}.${id} 使用了不支持的字段类型`);
  if (field.required !== undefined && typeof field.required !== 'boolean') {
    throw new Error(`${nodeId}.${id}.required 必须是布尔值`);
  }

  let options: Array<{ label: string; value: string }> | undefined;
  if (type === 'select') {
    if (!Array.isArray(field.options) || field.options.length === 0 || field.options.length > MAX_DIALOG_OPTIONS) {
      throw new Error(`${nodeId}.${id}.options 必须包含 1-${MAX_DIALOG_OPTIONS} 项`);
    }
    const seen = new Set<string>();
    options = field.options.map((rawOption, optionIndex) => {
      const option = objectValue(rawOption, `${nodeId}.${id}.options[${optionIndex}]`);
      const optionValue = nonEmptyString(option.value, `${nodeId}.${id}.options[${optionIndex}].value`, 128);
      if (seen.has(optionValue)) throw new Error(`${nodeId}.${id} 的选项值重复: ${optionValue}`);
      seen.add(optionValue);
      return {
        label: nonEmptyString(option.label, `${nodeId}.${id}.options[${optionIndex}].label`, 80),
        value: optionValue,
      };
    });
  } else if (field.options !== undefined) {
    throw new Error(`${nodeId}.${id} 只有 select 字段可以配置 options`);
  }

  let modelCategories: PluginCustomNodeFieldManifest['modelCategories'];
  if (type === 'model') {
    const rawCategories = field.modelCategories === undefined
      ? ['text', 'image', 'video', 'audio']
      : stringArray(field.modelCategories, `${nodeId}.${id}.modelCategories`, 4);
    if (rawCategories.some((category) => !MODEL_CATEGORIES.has(category))) {
      throw new Error(`${nodeId}.${id} 包含不支持的模型分类`);
    }
    modelCategories = [...new Set(rawCategories)] as PluginCustomNodeFieldManifest['modelCategories'];
  } else if (field.modelCategories !== undefined) {
    throw new Error(`${nodeId}.${id} 只有 model 字段可以配置 modelCategories`);
  }

  let defaultValue: string | number | boolean | undefined;
  if (field.defaultValue !== undefined) {
    if ((type === 'text' || type === 'textarea' || type === 'select') && typeof field.defaultValue === 'string') {
      defaultValue = field.defaultValue.slice(0, 4096);
    } else if (type === 'number' && typeof field.defaultValue === 'number' && Number.isFinite(field.defaultValue)) {
      defaultValue = field.defaultValue;
    } else if (type === 'boolean' && typeof field.defaultValue === 'boolean') {
      defaultValue = field.defaultValue;
    } else {
      throw new Error(`${nodeId}.${id}.defaultValue 与字段类型不匹配`);
    }
    if (type === 'select' && !options?.some((option) => option.value === defaultValue)) {
      throw new Error(`${nodeId}.${id}.defaultValue 不在选项中`);
    }
  }

  return {
    id,
    label: nonEmptyString(field.label, `${nodeId}.${id}.label`, 80),
    type,
    description: optionalString(field.description, `${nodeId}.${id}.description`, 160),
    placeholder: optionalString(field.placeholder, `${nodeId}.${id}.placeholder`, 120),
    required: field.required as boolean | undefined,
    defaultValue,
    options,
    modelCategories,
  };
}

function parseCustomNodes(value: unknown): PluginCustomNodeManifest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_NODES) {
    throw new Error(`contributes.nodes 必须是数组且不能超过 ${MAX_NODES} 项`);
  }
  const seenNodeIds = new Set<string>();
  return value.map((rawNode, index) => {
    const node = objectValue(rawNode, `nodes[${index}]`);
    const id = nonEmptyString(node.id, `nodes[${index}].id`, 64);
    if (!TOOL_ID_RE.test(id)) throw new Error(`自定义节点 id 无效: ${id}`);
    if (seenNodeIds.has(id)) throw new Error(`自定义节点 id 重复: ${id}`);
    seenNodeIds.add(id);
    const icon = nonEmptyString(node.icon, `${id}.icon`, 96);
    if (!ICON_RE.test(icon)) throw new Error(`${id}.icon 必须是 Iconify 图标名`);

    const parsePorts = (raw: unknown, key: 'inputs' | 'outputs') => {
      if (!Array.isArray(raw) || raw.length > MAX_NODE_PORTS) {
        throw new Error(`${id}.${key} 必须是数组且不能超过 ${MAX_NODE_PORTS} 项`);
      }
      const seen = new Set<string>();
      return raw.map((rawPort, portIndex) => {
        const port = objectValue(rawPort, `${id}.${key}[${portIndex}]`);
        const portId = nonEmptyString(port.id, `${id}.${key}[${portIndex}].id`, 64);
        if (!FIELD_RE.test(portId)) throw new Error(`${id} 的端口 id 无效: ${portId}`);
        if (seen.has(portId)) throw new Error(`${id}.${key} 的端口 id 重复: ${portId}`);
        seen.add(portId);
        const type = nonEmptyString(port.type, `${id}.${portId}.type`, 16) as PluginNodePortType;
        if (!PORT_TYPES.has(type)) throw new Error(`${id}.${portId} 使用了不支持的端口类型`);
        if (port.required !== undefined && typeof port.required !== 'boolean') {
          throw new Error(`${id}.${portId}.required 必须是布尔值`);
        }
        if (port.multiple !== undefined && typeof port.multiple !== 'boolean') {
          throw new Error(`${id}.${portId}.multiple 必须是布尔值`);
        }
        return {
          id: portId,
          label: nonEmptyString(port.label, `${id}.${portId}.label`, 80),
          type,
          required: port.required as boolean | undefined,
          multiple: port.multiple as boolean | undefined,
        };
      });
    };

    if (!Array.isArray(node.fields) || node.fields.length > MAX_DIALOG_FIELDS) {
      throw new Error(`${id}.fields 必须是数组且不能超过 ${MAX_DIALOG_FIELDS} 项`);
    }
    const fields = node.fields.map((field, fieldIndex) => parseCustomNodeField(field, id, fieldIndex));
    if (new Set(fields.map((field) => field.id)).size !== fields.length) {
      throw new Error(`${id}.fields 包含重复 id`);
    }
    return {
      id,
      title: nonEmptyString(node.title, `${id}.title`, 80),
      description: optionalString(node.description, `${id}.description`, 240),
      icon,
      inputs: parsePorts(node.inputs, 'inputs'),
      outputs: parsePorts(node.outputs, 'outputs'),
      fields,
    };
  });
}

function parseManifest(value: unknown): PluginManifest {
  const root = objectValue(value, 'manifest');
  if (root.apiVersion !== 1 && root.apiVersion !== 2 && root.apiVersion !== 3) {
    throw new Error('仅支持 apiVersion: 1、2 或 3');
  }
  const id = nonEmptyString(root.id, '插件 id', 128);
  if (!PLUGIN_ID_RE.test(id)) throw new Error('插件 id 只能使用小写字母、数字、点、下划线和短横线');
  const entry = nonEmptyString(root.entry, 'entry', 32);
  const runtime = (root.runtime === undefined ? 'javascript' : nonEmptyString(root.runtime, 'runtime', 16)) as PluginRuntime;
  if (runtime !== 'javascript' && runtime !== 'python') throw new Error('runtime 仅支持 javascript 或 python');
  if (root.apiVersion === 3) {
    if (runtime !== 'python') throw new Error('apiVersion: 3 当前仅用于可信 Python 插件');
    if (entry !== 'main.py') throw new Error('Python 插件入口必须是 main.py');
  } else {
    if (runtime === 'python') throw new Error('Python 插件必须使用 apiVersion: 3');
    if (entry !== 'main.js') throw new Error('JavaScript 插件入口必须是 main.js');
  }

  const permissions = stringArray(root.permissions, 'permissions', 8);
  if (permissions.some((permission) => !PERMISSIONS.has(permission as PluginPermission))) {
    throw new Error('插件声明了不支持的权限');
  }
  if (permissions.includes('models.invoke') && !permissions.includes('models.read')) {
    throw new Error('models.invoke 必须与 models.read 一起声明');
  }
  const contributes = objectValue(root.contributes, 'contributes');
  const rawNodeTools = contributes.nodeTools ?? [];
  if (!Array.isArray(rawNodeTools)) throw new Error('contributes.nodeTools 必须是数组');
  const customNodes = parseCustomNodes(contributes.nodes);
  if (root.apiVersion === 1 && customNodes.length > 0) throw new Error('自定义节点需要 apiVersion: 2 或 3');
  if (rawNodeTools.length === 0 && customNodes.length === 0) throw new Error('插件至少需要贡献一个节点工具或自定义节点');
  if (rawNodeTools.length > MAX_TOOLS) throw new Error(`节点工具不能超过 ${MAX_TOOLS} 个`);

  const seenToolIds = new Set<string>();
  const nodeTools = rawNodeTools.map((rawTool, index) => {
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
    const icon = tool.icon === undefined
      ? undefined
      : nonEmptyString(tool.icon, `${toolId}.icon`, 96);
    if (icon && !ICON_RE.test(icon)) {
      throw new Error(`${toolId}.icon 必须是 Iconify 图标名（例如 lucide:wand-sparkles）`);
    }
    if (placements.includes('node-toolbar') && !icon) {
      throw new Error(`${toolId} 使用节点工具栏入口时必须配置 icon`);
    }
    const dialog = tool.dialog === undefined ? undefined : parseToolDialog(tool.dialog, toolId);
    if (placements.includes('node-toolbar') && !dialog) {
      throw new Error(`${toolId} 使用节点工具栏入口时必须配置 dialog`);
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
      icon,
      dialog,
      nodeTypes: nodeTypes as NodeType[],
      inputFields,
      output: { mode, nodeType: outputNodeType, fields },
    };
  });

  if (nodeTools.some((tool) => tool.inputFields.length > 0) && !permissions.includes('node.read')) {
    throw new Error('读取节点输入的插件必须声明 node.read');
  }
  if (nodeTools.length > 0 && !permissions.includes('node.write')) {
    throw new Error('节点工具插件必须声明 node.write');
  }
  if (customNodes.length > 0 && !permissions.includes('node.write')) {
    throw new Error('自定义节点插件必须声明 node.write');
  }
  if (customNodes.some((node) => node.inputs.length > 0) && !permissions.includes('node.read')) {
    throw new Error('读取连线输入的自定义节点必须声明 node.read');
  }
  if (customNodes.some((node) => node.fields.some((field) => field.type === 'model')) && !permissions.includes('models.read')) {
    throw new Error('使用模型字段的自定义节点必须声明 models.read');
  }
  if (customNodes.some((node) => node.fields.some((field) => field.type === 'file')) && !permissions.includes('files.read')) {
    throw new Error('使用文件字段的自定义节点必须声明 files.read');
  }

  const category = nonEmptyString(root.category, '插件分类', 32) as PluginCategory;
  if (!CATEGORIES.has(category)) throw new Error('插件分类不受支持');
  const keywords = root.keywords === undefined ? undefined : stringArray(root.keywords, 'keywords', 12);
  const repository = root.repository === undefined
    ? undefined
    : normalizeGithubRepository(nonEmptyString(root.repository, 'repository', 512));

  return {
    apiVersion: root.apiVersion,
    runtime,
    id,
    name: nonEmptyString(root.name, '插件名称', 80),
    version: nonEmptyString(root.version, '插件版本', 32),
    author: typeof root.author === 'string' ? root.author.trim().slice(0, 80) : undefined,
    description: typeof root.description === 'string' ? root.description.trim().slice(0, 240) : undefined,
    repository,
    homepage: optionalHttpsUrl(root.homepage, 'homepage'),
    license: optionalString(root.license, 'license', 80),
    category,
    keywords,
    entry: entry as PluginManifest['entry'],
    permissions: [...new Set(permissions)] as PluginPermission[],
    contributes: { nodeTools, nodes: customNodes },
  };
}

export function parsePluginManifest(manifestText: string): PluginManifest {
  if (new Blob([manifestText]).size > MAX_MANIFEST_BYTES) throw new Error('manifest.json 过大');
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch {
    throw new Error('manifest.json 不是有效 JSON');
  }
  return parseManifest(raw);
}

export function parsePluginBundle(manifestText: string, source: string): PluginManifest {
  const manifest = parsePluginManifest(manifestText);
  if (new Blob([source]).size > MAX_SOURCE_BYTES) throw new Error(`${manifest.entry} 过大`);
  if (!source.trim()) throw new Error(`${manifest.entry} 不能为空`);
  return manifest;
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
