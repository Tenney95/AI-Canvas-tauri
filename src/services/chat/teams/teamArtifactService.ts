import type { TeamArtifactKind, TeamArtifactReference, TeamRoleId } from '../../../types/agentTeam';
import { readVerifiedProjectFile, sha256Hex, writeImmutableProjectFile } from '../../fs/projectFiles';
import { sanitizeDomainText } from '../subAgentMaterials';

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const ARTIFACT_PATH = /^agent-teams\/[A-Za-z0-9_-]{1,160}\/(?:input|outline|draft|review|decision|revision|original)-[a-f0-9]{64}\.json$/;
const ARTIFACT_KINDS: readonly TeamArtifactKind[] = ['input', 'outline', 'draft', 'review', 'decision', 'revision', 'original'];

function sanitizeJsonText(text: string): string {
  const sanitize = (value: unknown, depth = 0): unknown => {
    if (depth > 16) throw new Error('团队结构化产物层级过深');
    if (typeof value === 'string') return sanitizeDomainText(value);
    if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, depth + 1)]));
    return value;
  };
  return JSON.stringify(sanitize(JSON.parse(text)));
}

export async function hashTeamText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

export async function saveTeamArtifact(input: {
  projectId: string;
  runId: string;
  kind: TeamArtifactKind;
  text: string;
  label: string;
  stageId?: string;
  roleId?: TeamRoleId;
  parentArtifactIds?: string[];
  /** 主窗口捕获的项目/分集租约；仅运行时使用。 */
  assertCurrent?: () => void;
}): Promise<TeamArtifactReference> {
  input.assertCurrent?.();
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(input.runId) || !ARTIFACT_KINDS.includes(input.kind)) {
    throw new Error('团队产物身份无效');
  }
  // 恢复点是用户项目原稿，必须逐字保留（包括空正文），只写项目内容文件。
  const text = input.kind === 'original' ? input.text
    : ['input', 'review', 'decision'].includes(input.kind) ? sanitizeJsonText(input.text) : sanitizeDomainText(input.text);
  if (input.kind !== 'original' && !text.trim()) throw new Error('团队产物为空');
  const parentArtifactIds = [...new Set(input.parentArtifactIds ?? [])];
  const data = new TextEncoder().encode(JSON.stringify({ version: 1, runId: input.runId, kind: input.kind,
    stageId: input.stageId, roleId: input.roleId, parentArtifactIds, text }));
  if (data.byteLength > MAX_ARTIFACT_BYTES) throw new Error('团队产物超过保存上限');
  const sha256 = await sha256Hex(data);
  input.assertCurrent?.();
  const reference = {
    relativePath: `agent-teams/${input.runId}/${input.kind}-${sha256}.json`,
    sha256, bytes: data.byteLength,
  };
  try { await writeImmutableProjectFile({ projectId: input.projectId, reference, data, maxBytes: MAX_ARTIFACT_BYTES, assertCurrent: input.assertCurrent }); }
  catch (error) { throw new Error('无法保存团队产物，请在桌面端检查项目存储设置；不会自动重投模型', { cause: error }); }
  input.assertCurrent?.();
  return { ...reference, id: `${input.kind}-${sha256}`, kind: input.kind,
    label: sanitizeDomainText(input.label).slice(0, 100), createdAt: Date.now(),
    stageId: input.stageId, roleId: input.roleId, parentArtifactIds,
  };
}

/** 仅主窗口读取任务中已绑定的引用；独立窗口通过 taskId/artifactId 请求主窗口。 */
export async function readTeamArtifactText(projectId: string, reference: TeamArtifactReference): Promise<string> {
  if (!reference || !ARTIFACT_PATH.test(reference.relativePath)
    || !ARTIFACT_KINDS.includes(reference.kind)
    || reference.id !== `${reference.kind}-${reference.sha256}`
    || !reference.relativePath.endsWith(`/${reference.kind}-${reference.sha256}.json`)) {
    throw new Error('团队产物引用无效');
  }
  let data: Uint8Array;
  try { data = await readVerifiedProjectFile({ projectId, reference: {
    relativePath: reference.relativePath, sha256: reference.sha256, bytes: reference.bytes,
  }, maxBytes: MAX_ARTIFACT_BYTES }); }
  catch (error) { throw new Error('团队产物缺失或校验失败，请保留任务并检查项目存储', { cause: error }); }
  let document: unknown;
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { throw new Error('团队产物不是有效的 UTF-8 文档'); }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('团队产物文档无效');
  const raw = document as Record<string, unknown>;
  const runId = reference.relativePath.split('/')[1];
  if (raw.version !== 1 || raw.runId !== runId || raw.kind !== reference.kind || typeof raw.text !== 'string'
    || raw.stageId !== reference.stageId || raw.roleId !== reference.roleId
    || JSON.stringify(raw.parentArtifactIds) !== JSON.stringify(reference.parentArtifactIds)) {
    throw new Error('团队产物内容与任务引用不一致');
  }
  return raw.text;
}
