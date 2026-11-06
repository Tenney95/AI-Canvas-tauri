import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({
  data: new Map<string, Uint8Array>(),
  read: vi.fn(),
  write: vi.fn(),
}));

// 该用例只验证真实脱敏函数与文件合同，不初始化全应用 Store。
vi.mock('../../../src/store/useAppStore', () => ({ useAppStore: { getState: vi.fn() } }));

vi.mock(import('../../../src/services/fs/projectFiles'), async () => {
  const { createHash } = await import('node:crypto');
  return { sha256Hex: async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
    writeImmutableProjectFile: files.write, readVerifiedProjectFile: files.read };
});

import { readTeamArtifactText, saveTeamArtifact } from '../../../src/services/chat/teams/teamArtifactService';

beforeEach(() => {
  files.data.clear();
  files.write.mockReset().mockImplementation(async ({ projectId, reference, data }) => {
    files.data.set(`${projectId}/${reference.relativePath}`, Uint8Array.from(data));
    return { ...reference, created: true };
  });
  files.read.mockReset().mockImplementation(async ({ projectId, reference }) => {
    const data = files.data.get(`${projectId}/${reference.relativePath}`);
    if (!data) throw new Error('missing');
    return data;
  });
});

describe('团队产物文件与恢复原稿', () => {
  it('原稿恢复点逐字保留正文，也能保存空正文', async () => {
    const original = '场景一\r\nAPI_KEY=这只是剧本里的示例文字\n';
    const reference = await saveTeamArtifact({ projectId: 'p', runId: 'original-run', kind: 'original',
      text: original, label: '原稿' });
    expect(await readTeamArtifactText('p', reference)).toBe(original);
    const empty = await saveTeamArtifact({ projectId: 'p', runId: 'empty-run', kind: 'original', text: '', label: '空稿' });
    expect(await readTeamArtifactText('p', empty)).toBe('');
    expect(reference).not.toHaveProperty('text');
  });

  it('结构化内容按字段脱敏，凭据样式文字不会破坏JSON括号或其他字段', async () => {
    const reference = await saveTeamArtifact({ projectId: 'p', runId: 'review-run', kind: 'review',
      text: JSON.stringify({ evidence: 'authorization: TEST_ONLY', suggestion: '保留这条建议' }), label: '评审' });
    const text = await readTeamArtifactText('p', reference);
    expect(JSON.parse(text)).toEqual({ evidence: '[已脱敏凭据]', suggestion: '保留这条建议' });
  });

  it('两位独立审阅者即使正文相同也保留不同的角色产物身份', async () => {
    const text = JSON.stringify({ version: 1, artifactId: 'draft', artifactHash: 'a'.repeat(64), findings: [] });
    const first = await saveTeamArtifact({ projectId: 'p', runId: 'independent-run', kind: 'review',
      text, label: '连续性', stageId: 'continuity', roleId: 'continuity', parentArtifactIds: ['draft'] });
    const second = await saveTeamArtifact({ projectId: 'p', runId: 'independent-run', kind: 'review',
      text, label: '表达', stageId: 'dialogue', roleId: 'dialogue', parentArtifactIds: ['draft'] });
    expect(first.id).not.toBe(second.id);
    expect(await readTeamArtifactText('p', first)).toBe(await readTeamArtifactText('p', second));
    await expect(readTeamArtifactText('p', { ...first, roleId: 'dialogue' })).rejects.toThrow('不一致');
  });

  it('拒绝绝对路径与目录穿越引用，不把它交给文件读取器', async () => {
    const reference = await saveTeamArtifact({ projectId: 'p', runId: 'safe-run', kind: 'draft', text: '正文', label: '正文' });
    await expect(readTeamArtifactText('p', { ...reference, relativePath: '../outside.json' })).rejects.toThrow('引用无效');
    await expect(readTeamArtifactText('p', { ...reference, relativePath: 'C:/outside.json' })).rejects.toThrow('引用无效');
    expect(files.read).not.toHaveBeenCalled();
  });

  it('文档身份与引用不一致时拒绝返回正文', async () => {
    const reference = await saveTeamArtifact({ projectId: 'p', runId: 'identity-run', kind: 'draft', text: '正文', label: '正文' });
    files.data.set(`p/${reference.relativePath}`, new TextEncoder().encode(JSON.stringify({
      version: 1, runId: 'another-run', kind: 'draft', text: '其他任务正文',
    })));
    await expect(readTeamArtifactText('p', reference)).rejects.toThrow('不一致');
  });
});
