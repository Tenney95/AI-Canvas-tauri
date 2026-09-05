/**
 * 插件资源 Broker：把当前节点、直接入边和插件包资源映射为调用级不透明句柄。
 * 真实路径只保存在当前 Renderer 内存；插件输入、IndexedDB 和日志均不得持有路径。
 */
import { invoke } from '@tauri-apps/api/core';
import { lstat, readFile } from '@tauri-apps/plugin-fs';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import type {
  PluginCustomNodePortManifest,
  PluginInvocationResources,
  PluginPackageResourceManifest,
  PluginResourceAccessManifest,
  PluginResourceOrigin,
  PluginResourceRef,
  PluginPermission,
} from '../../types/plugin';
import { getRelativeAssetPath, resolveIndexedAssetPath } from '../fs/assetIndex';
import {
  getConvertFileSrc,
  getMimeType,
  getProjectDataDir,
  joinPath,
} from '../fs/core';
import { assertSafeProjectRelativePath } from '../fs/projectFiles';

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_RANGE_BYTES = 256 * 1024;
const MAX_RANGE_FALLBACK_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DERIVED_RESOURCE_BYTES = 4 * 1024 * 1024;
const MAX_DERIVED_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_DERIVED_RESOURCES = 25;
const DERIVED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface PluginResourceStateSnapshot {
  currentProjectId: string | null;
  nodes: ReadonlyArray<Node<BaseNodeData>>;
  edges: ReadonlyArray<Edge>;
  getCurrentRevision: () => number;
}

export interface MintPluginInvocationResourcesOptions {
  pluginId: string;
  sourceDigest: string;
  revisionDigest: string;
  invocationId: string;
  projectId: string;
  nodeId: string;
  baseRevision: number;
  access?: PluginResourceAccessManifest;
  inputPorts?: readonly PluginCustomNodePortManifest[];
  packageResources?: readonly PluginPackageResourceManifest[];
  state: PluginResourceStateSnapshot;
}

export interface PluginResourceReadContext {
  pluginId: string;
  sourceDigest: string;
  revisionDigest: string;
  invocationId: string;
  projectId: string;
  nodeId: string;
  baseRevision: number;
  permissions: readonly PluginPermission[];
  state: PluginResourceStateSnapshot;
}

interface ProjectResourceIdentity {
  path: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  displayName: string;
  mediaType: string;
}

interface PluginResourceLease {
  ref: PluginResourceRef;
  pluginId: string;
  sourceDigest: string;
  revisionDigest: string;
  invocationId: string;
  projectId: string;
  nodeId: string;
  baseRevision: number;
  path?: string;
  relativePath?: string;
  mtimeMs?: number;
  packageResourceId?: string;
  sourceNodeId?: string;
  edgeId?: string;
  portId?: string;
  /** invocation 内宿主生成的派生资源；不落盘、不暴露真实路径。 */
  bytes?: Uint8Array;
}

const resourceLeases = new Map<string, PluginResourceLease>();

function createResourceId(): string {
  return `plugin-resource-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function normalizedMtime(value: Date | null | undefined): number {
  return value?.getTime() ?? 0;
}

function displayNameFromPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? 'resource';
}

function extensionFromPath(path: string): string {
  const name = displayNameFromPath(path);
  const separator = name.lastIndexOf('.');
  return separator > 0 ? name.slice(separator + 1).toLowerCase() : '';
}

function mimeMatches(mediaType: string, accepts: readonly string[] | undefined): boolean {
  if (!accepts?.length) return true;
  return accepts.some((accept) => (
    accept.endsWith('/*')
      ? mediaType.startsWith(accept.slice(0, -1))
      : mediaType === accept
  ));
}

async function assertOrdinaryPath(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split('/');
  let current = root;
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory || rootInfo.isSymlink) throw new Error('项目资源根目录无效');
  for (let index = 0; index < segments.length; index += 1) {
    current = joinPath(current, segments[index]);
    const info = await lstat(current);
    if (info.isSymlink) throw new Error('插件不能读取符号链接资源');
    if (index < segments.length - 1 && !info.isDirectory) throw new Error('项目资源父路径无效');
    if (index === segments.length - 1 && !info.isFile) throw new Error('插件资源不是普通文件');
  }
}

async function resolveNodeProjectResource(
  projectId: string,
  node: Node<BaseNodeData>,
): Promise<ProjectResourceIdentity | null> {
  const root = await getProjectDataDir(projectId);
  if (!root) return null;

  let candidate: string | null = null;
  if (typeof node.data.assetId === 'string' && node.data.assetId) {
    candidate = await resolveIndexedAssetPath(node.data.assetId);
  }
  if (!candidate && typeof node.data.relativePath === 'string' && node.data.relativePath) {
    candidate = joinPath(root, assertSafeProjectRelativePath(node.data.relativePath));
  }
  if (!candidate && typeof node.data.filePath === 'string' && node.data.filePath) {
    candidate = node.data.filePath;
  }
  if (!candidate) return null;

  const relativePath = getRelativeAssetPath(candidate, root);
  if (!relativePath) throw new Error('插件只能读取当前项目目录内的节点资源');
  const safeRelativePath = assertSafeProjectRelativePath(relativePath);
  await assertOrdinaryPath(root, safeRelativePath);
  const path = joinPath(root, safeRelativePath);
  const info = await lstat(path);
  if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error('插件资源大小无效');
  return {
    path,
    relativePath: safeRelativePath,
    size: info.size,
    mtimeMs: normalizedMtime(info.mtime),
    displayName: typeof node.data.fileName === 'string' && node.data.fileName
      ? node.data.fileName
      : displayNameFromPath(path),
    mediaType: getMimeType(extensionFromPath(path)),
  };
}

function addLease(
  options: MintPluginInvocationResourcesOptions,
  origin: PluginResourceOrigin,
  identity: ProjectResourceIdentity,
  source: { nodeId: string; edgeId?: string; portId?: string },
): PluginResourceRef {
  const ref: PluginResourceRef = {
    resourceId: createResourceId(),
    origin,
    displayName: identity.displayName,
    mediaType: identity.mediaType,
    size: identity.size,
    access: 'read',
    source,
  };
  resourceLeases.set(ref.resourceId, {
    ref,
    pluginId: options.pluginId,
    sourceDigest: options.sourceDigest,
    revisionDigest: options.revisionDigest,
    invocationId: options.invocationId,
    projectId: options.projectId,
    nodeId: options.nodeId,
    baseRevision: options.baseRevision,
    path: identity.path,
    relativePath: identity.relativePath,
    mtimeMs: identity.mtimeMs,
    sourceNodeId: source.nodeId,
    edgeId: source.edgeId,
    portId: source.portId,
  });
  return ref;
}

function addPackageLease(
  options: MintPluginInvocationResourcesOptions,
  resource: PluginPackageResourceManifest,
): PluginResourceRef {
  const ref: PluginResourceRef = {
    resourceId: createResourceId(),
    origin: 'package',
    displayName: displayNameFromPath(resource.path),
    mediaType: resource.mediaType,
    size: resource.bytes,
    sha256: resource.integrity.replace(/^sha256-/, ''),
    access: 'read',
  };
  resourceLeases.set(ref.resourceId, {
    ref,
    pluginId: options.pluginId,
    sourceDigest: options.sourceDigest,
    revisionDigest: options.revisionDigest,
    invocationId: options.invocationId,
    projectId: options.projectId,
    nodeId: options.nodeId,
    baseRevision: options.baseRevision,
    packageResourceId: resource.id,
  });
  return ref;
}

export async function mintPluginInvocationResources(
  options: MintPluginInvocationResourcesOptions,
): Promise<PluginInvocationResources> {
  if (options.state.currentProjectId !== options.projectId) throw new Error('插件资源项目已切换');
  if (options.state.getCurrentRevision() !== options.baseRevision) throw new Error('画布已变化，无法授权插件资源');
  const targetNode = options.state.nodes.find((node) => node.id === options.nodeId);
  if (!targetNode) throw new Error('插件目标节点不存在');

  const result: PluginInvocationResources = {
    self: [],
    incoming: [],
    inputs: {},
    package: [],
    derived: [],
  };
  if (options.access?.self) {
    const identity = await resolveNodeProjectResource(options.projectId, targetNode);
    if (identity) result.self.push(addLease(options, 'node-self', identity, { nodeId: targetNode.id }));
  }

  if (options.access?.incoming) {
    const allowedPorts = options.access.portIds ? new Set(options.access.portIds) : null;
    for (const edge of options.state.edges.filter((item) => item.target === options.nodeId)) {
      const portId = edge.targetHandle?.startsWith('plugin-in-')
        ? edge.targetHandle.slice('plugin-in-'.length)
        : undefined;
      const port = portId ? options.inputPorts?.find((item) => item.id === portId) : undefined;
      // 自定义节点必须由精确的 plugin-in-<portId> 连线取得资源；缺失或未知 Handle 不回退。
      if (options.inputPorts && (!portId || !port)) continue;
      if (allowedPorts && (!portId || !allowedPorts.has(portId))) continue;
      const sourceNode = options.state.nodes.find((node) => node.id === edge.source);
      if (!sourceNode) continue;
      const identity = await resolveNodeProjectResource(options.projectId, sourceNode);
      if (!identity) continue;
      if (port?.maxBytes !== undefined && identity.size > port.maxBytes) {
        throw new Error(`输入「${port.label}」的资源超过声明大小上限`);
      }
      if (!mimeMatches(identity.mediaType, port?.accept)) {
        throw new Error(`输入「${port?.label ?? portId ?? '资源'}」的文件类型不受支持`);
      }
      if (portId && port && !port.multiple && (result.inputs[portId]?.length ?? 0) > 0) {
        throw new Error(`输入「${port.label}」只允许一条连线`);
      }
      const ref = addLease(options, 'connection', identity, {
        nodeId: sourceNode.id,
        edgeId: edge.id,
        portId,
      });
      result.incoming.push(ref);
      if (portId) (result.inputs[portId] ??= []).push(ref);
    }
  }

  for (const resource of options.packageResources ?? []) {
    result.package.push(addPackageLease(options, resource));
  }
  return result;
}

function requireLease(context: PluginResourceReadContext, resourceId: string): PluginResourceLease {
  const lease = resourceLeases.get(resourceId);
  if (
    !lease
    || lease.pluginId !== context.pluginId
    || lease.sourceDigest !== context.sourceDigest
    || lease.revisionDigest !== context.revisionDigest
    || lease.invocationId !== context.invocationId
    || lease.projectId !== context.projectId
    || lease.nodeId !== context.nodeId
    || lease.baseRevision !== context.baseRevision
  ) {
    throw new Error('插件资源授权不存在、已失效或不属于当前调用');
  }
  if (
    context.state.currentProjectId !== context.projectId
    || context.state.getCurrentRevision() !== context.baseRevision
    || !context.state.nodes.some((node) => node.id === context.nodeId)
  ) {
    throw new Error('画布已变化，插件资源授权已撤销');
  }
  if (lease.edgeId) {
    const edge = context.state.edges.find((item) => item.id === lease.edgeId);
    if (!edge || edge.source !== lease.sourceNodeId || edge.target !== context.nodeId) {
      throw new Error('插件资源连线已变化，授权已撤销');
    }
    const currentPortId = edge.targetHandle?.startsWith('plugin-in-')
      ? edge.targetHandle.slice('plugin-in-'.length)
      : undefined;
    if (lease.portId && currentPortId !== lease.portId) throw new Error('插件资源端口已变化，授权已撤销');
  }
  if (lease.sourceNodeId && !context.state.nodes.some((node) => node.id === lease.sourceNodeId)) {
    throw new Error('插件资源来源节点已删除，授权已撤销');
  }
  if (lease.packageResourceId) {
    if (!context.permissions.includes('plugin.resources.read')) {
      throw new Error('插件未声明 plugin.resources.read 权限');
    }
  } else if (lease.bytes) {
    if (
      !context.permissions.includes('files.connected.read')
      || !context.permissions.includes('files.output.create')
    ) {
      throw new Error('派生资源要求 files.connected.read 与 files.output.create 权限');
    }
  } else if (!context.permissions.includes('files.connected.read')) {
    throw new Error('插件未声明 files.connected.read 权限');
  }
  return lease;
}

/** 把宿主 effect 生成的图像登记为当前 invocation 的内存资源。 */
export function registerPluginDerivedResource(
  context: PluginResourceReadContext,
  resources: PluginInvocationResources,
  options: {
    displayName: string;
    mediaType: string;
    bytes: Uint8Array;
  },
): PluginResourceRef {
  if (
    context.state.currentProjectId !== context.projectId
    || context.state.getCurrentRevision() !== context.baseRevision
    || !context.state.nodes.some((node) => node.id === context.nodeId)
  ) {
    throw new Error('画布已变化，不能登记派生资源');
  }
  if (
    !context.permissions.includes('files.connected.read')
    || !context.permissions.includes('files.output.create')
  ) {
    throw new Error('派生资源要求 files.connected.read 与 files.output.create 权限');
  }
  if (!DERIVED_MEDIA_TYPES.has(options.mediaType)) throw new Error('派生资源必须是受支持的图像');
  if (options.bytes.byteLength <= 0 || options.bytes.byteLength > MAX_DERIVED_RESOURCE_BYTES) {
    throw new Error('单个派生资源不能超过 4 MiB');
  }
  if (resources.derived.length >= MAX_DERIVED_RESOURCES) {
    throw new Error(`单次调用最多登记 ${MAX_DERIVED_RESOURCES} 个派生资源`);
  }
  const invocationBytes = resources.derived.reduce((total, resource) => total + resource.size, 0);
  if (invocationBytes + options.bytes.byteLength > MAX_DERIVED_TOTAL_BYTES) {
    throw new Error('单次调用的派生资源总量不能超过 48 MiB');
  }

  const ref: PluginResourceRef = {
    resourceId: createResourceId(),
    origin: 'derived',
    displayName: options.displayName.slice(0, 120) || 'derived-image.jpg',
    mediaType: options.mediaType,
    size: options.bytes.byteLength,
    access: 'read',
  };
  resourceLeases.set(ref.resourceId, {
    ref,
    pluginId: context.pluginId,
    sourceDigest: context.sourceDigest,
    revisionDigest: context.revisionDigest,
    invocationId: context.invocationId,
    projectId: context.projectId,
    nodeId: context.nodeId,
    baseRevision: context.baseRevision,
    bytes: options.bytes.slice(),
  });
  resources.derived.push(ref);
  return ref;
}

async function revalidateProjectLease(
  context: PluginResourceReadContext,
  lease: PluginResourceLease,
): Promise<ProjectResourceIdentity> {
  if (!lease.sourceNodeId || !lease.path || !lease.relativePath) throw new Error('插件项目资源租约无效');
  const node = context.state.nodes.find((item) => item.id === lease.sourceNodeId);
  if (!node) throw new Error('插件资源来源节点已删除，授权已撤销');
  const current = await resolveNodeProjectResource(context.projectId, node);
  if (
    !current
    || current.relativePath !== lease.relativePath
    || current.size !== lease.ref.size
    || current.mtimeMs !== lease.mtimeMs
  ) {
    throw new Error('插件资源文件已变化，授权已撤销');
  }
  return current;
}

async function readPackageRange(
  context: PluginResourceReadContext,
  lease: PluginResourceLease,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  if (!lease.packageResourceId) throw new Error('插件包资源租约无效');
  const bytes = await invoke<number[]>('read_plugin_package_resource', {
    pluginId: context.pluginId,
    sourceDigest: context.sourceDigest,
    revisionDigest: context.revisionDigest,
    resourceId: lease.packageResourceId,
    invocationId: context.invocationId,
    offset,
    length,
  });
  return Uint8Array.from(bytes);
}

async function readProjectRange(identity: ProjectResourceIdentity, offset: number, length: number): Promise<Uint8Array> {
  const convert = getConvertFileSrc();
  if (convert) {
    const response = await fetch(convert(identity.path), {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    });
    if (response.ok) {
      if (response.status !== 206 && identity.size > MAX_RANGE_FALLBACK_FILE_BYTES) {
        void response.body?.cancel();
        throw new Error('当前环境不支持对该大型资源进行分段读取');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return response.status === 206 ? bytes.slice(0, length) : bytes.slice(offset, offset + length);
    }
  }
  if (identity.size > MAX_RANGE_FALLBACK_FILE_BYTES) {
    throw new Error('当前环境不支持对该大型资源进行分段读取');
  }
  return (await readFile(identity.path)).slice(offset, offset + length);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function readPluginResourceRange(
  context: PluginResourceReadContext,
  resourceId: string,
  offset: number,
  length: number,
): Promise<{ resource: PluginResourceRef; offset: number; bytes: number; base64: string }> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('资源读取 offset 无效');
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_RANGE_BYTES) {
    throw new Error('资源单次读取不能超过 256 KiB');
  }
  const lease = requireLease(context, resourceId);
  if (offset >= lease.ref.size) throw new Error('资源读取 offset 超出文件范围');
  const safeLength = Math.min(length, lease.ref.size - offset);
  const bytes = lease.bytes
    ? lease.bytes.slice(offset, offset + safeLength)
    : lease.packageResourceId
      ? await readPackageRange(context, lease, offset, safeLength)
      : await readProjectRange(await revalidateProjectLease(context, lease), offset, safeLength);
  return { resource: lease.ref, offset, bytes: bytes.byteLength, base64: bytesToBase64(bytes) };
}

export async function readPluginResourceText(
  context: PluginResourceReadContext,
  resourceId: string,
  requestedMaxBytes?: number,
): Promise<{ resource: PluginResourceRef; content: string }> {
  const maxBytes = requestedMaxBytes === undefined
    ? MAX_TEXT_BYTES
    : Math.min(MAX_TEXT_BYTES, requestedMaxBytes);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('文本资源读取上限无效');
  const lease = requireLease(context, resourceId);
  if (lease.ref.size > maxBytes) throw new Error('文本资源超过本次读取上限');
  if (lease.bytes && !lease.ref.mediaType.startsWith('text/')) {
    throw new Error('派生图像资源不能按文本读取');
  }
  const bytes = lease.bytes
    ? lease.bytes
    : lease.packageResourceId
      ? await readPackageRange(context, lease, 0, lease.ref.size)
      : await readFile((await revalidateProjectLease(context, lease)).path);
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('资源不是有效的 UTF-8 文本');
  }
  return { resource: lease.ref, content };
}

/** 仅供宿主模型适配器使用；返回值不得进入插件输入或日志。 */
export async function resolvePluginResourceHostUrl(
  context: PluginResourceReadContext,
  resourceId: string,
): Promise<string> {
  const lease = requireLease(context, resourceId);
  if (lease.packageResourceId) throw new Error('插件包资源不能直接作为本地媒体引用');
  if (lease.bytes) {
    return `data:${lease.ref.mediaType};base64,${bytesToBase64(lease.bytes)}`;
  }
  const identity = await revalidateProjectLease(context, lease);
  const convert = getConvertFileSrc();
  if (!convert) throw new Error('当前环境不能解析本地媒体资源');
  return convert(identity.path);
}

/** 最终节点集写回使用；只返回宿主登记的派生字节副本。 */
export function readPluginDerivedResourceForOutput(
  context: PluginResourceReadContext,
  resourceId: string,
): { resource: PluginResourceRef; bytes: Uint8Array } {
  const lease = requireLease(context, resourceId);
  if (lease.ref.origin !== 'derived' || !lease.bytes) throw new Error('节点集只能绑定宿主派生资源');
  return { resource: lease.ref, bytes: lease.bytes.slice() };
}

export function clearPluginInvocationResources(invocationId: string): void {
  for (const [resourceId, lease] of resourceLeases) {
    if (lease.invocationId === invocationId) resourceLeases.delete(resourceId);
  }
}

export function clearPluginResources(pluginId?: string): void {
  for (const [resourceId, lease] of resourceLeases) {
    if (!pluginId || lease.pluginId === pluginId) resourceLeases.delete(resourceId);
  }
}
