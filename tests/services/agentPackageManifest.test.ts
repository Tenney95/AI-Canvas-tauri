import { describe, expect, it } from 'vitest';
import {
  AGENT_PACKAGE_INSTRUCTION_MAX_CHARS,
  createLegacyAgentPackageManifest,
  normalizeAgentPackageInstallation,
  normalizeAgentSourcePreview,
  parseAgentPackageManifest,
} from '../../src/services/agentPackages/agentPackageManifest';
import type { AgentPackageManifest, AgentSourcePreview } from '../../src/types/agentPackage';

const HASH = 'a'.repeat(64);

function manifest(partial: Partial<AgentPackageManifest> = {}): AgentPackageManifest {
  return {
    schemaVersion: 1,
    id: 'com.example.story-agent',
    name: '短剧助手',
    version: '1.2.3',
    description: '按需调用的测试智能体',
    entrypoints: { instructions: 'AGENTS.md', router: 'routes/router.md' },
    supportedScopes: ['global', 'project'],
    supportedSurfaces: ['assistant', 'canvas'],
    routing: {
      userInvocable: true,
      autoInvoke: false,
      whenToUse: '用户要求创作短剧时使用',
      triggers: ['短剧', '分镜'],
    },
    contributes: {
      skillRoots: ['skills'],
      knowledgeRoots: ['knowledge'],
      assetRoots: ['assets'],
      requestedTools: ['canvas_query'],
      excludePaths: ['archive'],
    },
    ...partial,
  };
}

function preview(partial: Partial<AgentSourcePreview> = {}): AgentSourcePreview {
  const value = manifest();
  return {
    sourceId: 'agent-source:preview-1',
    sourceType: 'folder',
    name: value.name,
    version: value.version,
    manifest: value,
    entrypoints: ['AGENTS.md', 'routes/router.md'],
    instructionText: '# 只读入口说明',
    skillCount: 28,
    fileCount: 534,
    totalBytes: 620_971_381,
    warnings: [],
    health: 'ready',
    contentHash: HASH,
    ...partial,
  };
}

describe('Agent Package Manifest', () => {
  it('parses and normalizes a bounded v1 manifest', () => {
    const parsed = parseAgentPackageManifest(JSON.stringify(manifest({
      entrypoints: { instructions: 'docs\\AGENTS.md' },
    })));

    expect(parsed).toMatchObject({
      id: 'com.example.story-agent',
      version: '1.2.3',
      entrypoints: { instructions: 'docs/AGENTS.md' },
    });
  });

  it.each([
    '../AGENTS.md',
    '/etc/passwd',
    'C:\\secret.txt',
    'docs//AGENTS.md',
    './AGENTS.md',
  ])('rejects unsafe package path %s', (instructions) => {
    expect(() => parseAgentPackageManifest(JSON.stringify(manifest({
      entrypoints: { instructions },
    })))).toThrow('相对路径');
  });

  it('rejects unknown fields, non-SemVer versions and unsupported tool ids', () => {
    expect(() => parseAgentPackageManifest(JSON.stringify({
      ...manifest(),
      embeddedBusinessAgent: true,
    }))).toThrow('不支持的字段');
    expect(() => parseAgentPackageManifest(JSON.stringify(manifest({ version: 'latest' })))).toThrow('SemVer');
    expect(() => parseAgentPackageManifest(JSON.stringify(manifest({
      contributes: { requestedTools: ['bad tool'] },
    })))).toThrow('无效工具 ID');
  });

  it('rejects oversized manifests and instruction snapshots', () => {
    expect(() => parseAgentPackageManifest(JSON.stringify({
      ...manifest(),
      description: 'x'.repeat(70_000),
    }))).toThrow('过大');
    expect(() => normalizeAgentSourcePreview(preview({
      instructionText: 'x'.repeat(AGENT_PACKAGE_INSTRUCTION_MAX_CHARS + 1),
    }))).toThrow('instructionText');
  });

  it('normalizes native previews without accepting paths or manifest drift', () => {
    expect(normalizeAgentSourcePreview(preview())).toMatchObject({
      sourceId: 'agent-source:preview-1',
      sourceType: 'folder',
      health: 'ready',
      skillCount: 28,
    });
    expect(() => normalizeAgentSourcePreview(preview({ sourceId: 'G:\\agent' }))).toThrow('不能包含路径');
    expect(() => normalizeAgentSourcePreview(preview({ name: '伪造名称' }))).toThrow('不一致');
    expect(() => normalizeAgentSourcePreview(preview({ entrypoints: ['AGENTS.md'] }))).toThrow('缺少');
  });

  it('creates a conservative host-side manifest for legacy directories', () => {
    const normalized = normalizeAgentSourcePreview(preview({
      manifest: null,
      health: 'degraded',
      entrypoints: ['skills/first/SKILL.md', 'AGENTS.md'],
    }));

    expect(createLegacyAgentPackageManifest(normalized)).toMatchObject({
      id: `legacy.${HASH.slice(0, 16)}`,
      entrypoints: { instructions: 'AGENTS.md' },
      supportedScopes: ['global', 'project', 'series'],
      supportedSurfaces: ['assistant'],
      routing: { userInvocable: true, autoInvoke: false },
    });
  });

  it('revalidates persisted records and rejects source path fields', () => {
    const now = Date.now();
    const sourcePreview = preview();
    const record = {
      id: 'agent-package-1',
      packageId: manifest().id,
      manifest: manifest(),
      source: {
        sourceId: sourcePreview.sourceId,
        sourceType: sourcePreview.sourceType,
        displayName: sourcePreview.name,
      },
      entrypoints: sourcePreview.entrypoints,
      skillCount: sourcePreview.skillCount,
      fileCount: sourcePreview.fileCount,
      totalBytes: sourcePreview.totalBytes,
      warnings: [],
      health: 'ready',
      contentHash: HASH,
      enabled: true,
      installedAt: now,
      updatedAt: now,
    };

    expect(normalizeAgentPackageInstallation(record)).toMatchObject({
      packageId: manifest().id,
      mcpSkillReadEnabled: false,
    });
    expect(() => normalizeAgentPackageInstallation({
      ...record,
      instructionText: sourcePreview.instructionText,
    })).toThrow('不支持的字段');
    expect(() => normalizeAgentPackageInstallation({
      ...record,
      source: { ...record.source, path: 'G:\\AI短剧知识库' },
    })).toThrow('不支持的字段');
  });
});
