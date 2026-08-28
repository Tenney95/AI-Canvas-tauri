/**
 * 智能体包导入入口。
 *
 * 文件选择发生在 Renderer，但目录授权、归档解包与 Manifest 预检全部交给
 * Rust 命令完成；前端只接收不含绝对路径的安装预览。
 */
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { AgentSourcePreview } from '../../types/agentPackage';

export type AgentPackageImportPreview = AgentSourcePreview;

export interface AgentPackageSourceRemoveResult {
  sourceId: string;
  sourceType: AgentSourcePreview['sourceType'];
  removed: boolean;
  externalSourcePreserved: boolean;
}

const ARCHIVE_EXTENSIONS = ['aicanvas-agent', 'tgz', 'tar.gz'];

function selectedSinglePath(selected: string | string[] | null): string | null {
  if (!selected || Array.isArray(selected)) return null;
  return selected;
}

function isSupportedArchive(path: string): boolean {
  const lower = path.toLocaleLowerCase();
  return lower.endsWith('.aicanvas-agent')
    || lower.endsWith('.tgz')
    || lower.endsWith('.tar.gz');
}

/** 选择本地文件夹并生成只读链接预览；用户取消时返回 null。 */
export async function selectAgentPackageFolder(): Promise<AgentPackageImportPreview | null> {
  const selected = selectedSinglePath(await open({
    directory: true,
    multiple: false,
    title: '选择智能体文件夹',
  }));
  if (!selected) return null;
  return invoke<AgentPackageImportPreview>('agent_source_link', { sourcePath: selected });
}

/** 选择受支持的智能体压缩包并导入到托管目录；用户取消时返回 null。 */
export async function selectAgentPackageArchive(): Promise<AgentPackageImportPreview | null> {
  const selected = selectedSinglePath(await open({
    directory: false,
    multiple: false,
    title: '选择智能体压缩包',
    filters: [{ name: 'AI Canvas 智能体包', extensions: ARCHIVE_EXTENSIONS }],
  }));
  if (!selected) return null;
  if (!isSupportedArchive(selected)) {
    throw new Error('仅支持 .aicanvas-agent、.tgz 或 .tar.gz 智能体包');
  }
  return invoke<AgentPackageImportPreview>('agent_package_import_archive', { archivePath: selected });
}

/**
 * 移除原生来源注册；文件夹来源只解除链接，归档来源同时清理托管副本。
 * 调用方应先删除目录记录，且把原生清理失败视为可恢复的 best-effort 结果。
 */
export async function removeAgentPackageSource(
  sourceId: string,
): Promise<AgentPackageSourceRemoveResult> {
  return invoke<AgentPackageSourceRemoveResult>('agent_source_remove', { sourceId });
}
