import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  isTauriEnv: vi.fn(() => true),
  ensureProjectDataDir: vi.fn(async () => 'G:/project-data'),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('../../src/services/fs/core', () => ({
  isTauriEnv: mocks.isTauriEnv,
  ensureProjectDataDir: mocks.ensureProjectDataDir,
  getConvertFileSrc: () => mocks.convertFileSrc,
  joinPath: (...parts: string[]) => parts
    .map((part) => part.replace(/\\/g, '/').replace(/\/+$/g, ''))
    .join('/')
    .replace(/\/+/g, '/'),
}));

const SCENE_HASH = 'a'.repeat(64);
const ARTIFACT_HASH = 'c'.repeat(64);
const MANIFEST_HASH = 'd'.repeat(64);

const sceneReference = {
  schemaVersion: 1 as const,
  sceneId: 'scene-main',
  revision: 1,
  relativePath: `director/scenes/scene-main/scene-r1-${SCENE_HASH}.json`,
  sha256: SCENE_HASH,
  bytes: 1024,
};

const installation = {
  installationId: 'blender-installation-auto',
  displayName: 'Blender 5.2.1',
  source: 'auto-discovery',
  versionHint: '5.2.1',
  versionHintIsVerified: true,
};

function jobStatus(
  state: 'running' | 'awaiting-collection' | 'failed',
  failure: { code: string; message: string } | null = null,
) {
  return {
    jobId: 'blender-job-1',
    operation: 'render-frame',
    state,
    sceneId: 'scene-main',
    sceneRevision: 1,
    progress: state === 'running'
      ? { phase: 'rendering', completed: 1, total: 2 }
      : null,
    failure,
    createdAtMs: 100,
    updatedAtMs: 101,
  };
}

function collectedResult(overrides: {
  sceneSha256?: string;
  manifestRevision?: number;
  referenceManifestRevision?: number;
} = {}) {
  const sceneSha256 = overrides.sceneSha256 ?? SCENE_HASH;
  const manifestRevision = overrides.manifestRevision ?? 1;
  const referenceManifestRevision = overrides.referenceManifestRevision ?? manifestRevision;
  return {
    manifest: {
      schemaVersion: 1,
      sceneId: 'scene-main',
      sceneRevision: 1,
      sceneSha256,
      manifestRevision,
      producer: {
        runtime: 'blender',
        adapterVersion: '1.0.0',
        blenderVersion: '5.2.1',
      },
      artifacts: [{
        artifactId: 'frame-a',
        kind: 'frame-image',
        mimeType: 'image/png',
        relativePath: `director/scenes/scene-main/results/frame-a-${ARTIFACT_HASH}.png`,
        sha256: ARTIFACT_HASH,
        bytes: 256,
        frame: 48,
      }],
    },
    manifestReference: {
      schemaVersion: 1,
      sceneId: 'scene-main',
      sceneRevision: 1,
      sceneSha256,
      manifestRevision: referenceManifestRevision,
      relativePath:
        `director/scenes/scene-main/results/manifest-r${referenceManifestRevision}-${MANIFEST_HASH}.json`,
      sha256: MANIFEST_HASH,
      bytes: 512,
    },
  };
}

async function loadService() {
  return import('../../src/services/directorBlenderRuntimeService');
}

function renderFrameInput(targetFrame = 48) {
  return {
    operation: 'render-frame' as const,
    projectId: 'project-a',
    directorInstanceId: 'director-node-a',
    sceneReference,
    targetFrame,
  };
}

function commandNames(): string[] {
  return mocks.invoke.mock.calls.map(([command]) => command as string);
}

async function flushPromiseChain(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.isTauriEnv.mockReturnValue(true);
  mocks.ensureProjectDataDir.mockResolvedValue('G:/project-data');
  mocks.convertFileSrc.mockImplementation((path: string) => `asset://localhost/${path}`);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('directorBlenderRuntimeService', () => {
  it('直接采用唯一发现候选，不打开文件选择器也不登记绝对路径', async () => {
    mocks.invoke.mockResolvedValueOnce({ candidates: [installation] });
    const service = await loadService();

    await expect(service.prepareDirectorBlenderInstallation()).resolves.toEqual(installation);

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('discover_blender_installations');
    expect(mocks.open).not.toHaveBeenCalled();
    const exposed = service.getSelectedDirectorBlenderInstallation();
    expect(exposed).toEqual(installation);
    if (exposed) exposed.displayName = '外部修改';
    expect(service.getSelectedDirectorBlenderInstallation()?.displayName)
      .toBe(installation.displayName);
  });

  it('重启后优先恢复原生层保存的手选候选', async () => {
    const persistedInstallation = {
      ...installation,
      installationId: 'blender-installation-persisted',
      displayName: 'Blender（手动选择）',
      source: 'user-selected',
      versionHint: null,
      versionHintIsVerified: false,
    };
    mocks.invoke.mockResolvedValueOnce({
      candidates: [persistedInstallation, installation],
    });
    const service = await loadService();

    await expect(service.detectDirectorBlenderInstallation())
      .resolves.toEqual(persistedInstallation);

    expect(mocks.invoke).toHaveBeenCalledWith('discover_blender_installations');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(service.getSelectedDirectorBlenderInstallation()).not.toHaveProperty('executablePath');
  });

  it('设置页主动更换时直接打开选择器，且只返回不含路径的候选摘要', async () => {
    const manualInstallation = {
      ...installation,
      installationId: 'blender-installation-settings',
      displayName: 'Blender（手动选择）',
      source: 'user-selected',
      versionHint: null,
      versionHintIsVerified: false,
    };
    mocks.open.mockResolvedValue('F:\\Steam\\Blender\\blender.exe');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'register_blender_installation') {
        return { ...manualInstallation, executablePath: 'F:\\Steam\\Blender\\blender.exe' };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const service = await loadService();

    await expect(service.chooseDirectorBlenderInstallation()).resolves.toEqual(manualInstallation);

    expect(commandNames()).toEqual(['register_blender_installation']);
    expect(mocks.invoke).toHaveBeenCalledWith('register_blender_installation', {
      request: { executablePath: 'F:\\Steam\\Blender\\blender.exe' },
    });
    expect(service.getSelectedDirectorBlenderInstallation()).not.toHaveProperty('executablePath');

    vi.clearAllMocks();
    await expect(service.prepareDirectorBlenderInstallation()).resolves.toEqual(manualInstallation);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('取消重新选择时保留当前候选', async () => {
    mocks.invoke.mockResolvedValueOnce({ candidates: [installation] });
    mocks.open.mockResolvedValue(null);
    const service = await loadService();
    await service.detectDirectorBlenderInstallation();

    await expect(service.chooseDirectorBlenderInstallation())
      .rejects.toMatchObject({ name: 'AbortError' });

    expect(service.getSelectedDirectorBlenderInstallation()).toEqual(installation);
    expect(commandNames()).toEqual(['discover_blender_installations']);
  });

  it('较晚返回的自动发现不会覆盖用户已手选的候选', async () => {
    const manualInstallation = {
      ...installation,
      installationId: 'blender-installation-race-manual',
      displayName: 'Blender（手动选择）',
      source: 'user-selected',
      versionHint: null,
      versionHintIsVerified: false,
    };
    let resolveDiscovery!: (value: { candidates: typeof installation[] }) => void;
    const delayedDiscovery = new Promise<{ candidates: typeof installation[] }>((resolve) => {
      resolveDiscovery = resolve;
    });
    mocks.open.mockResolvedValue('F:\\Blender\\blender.exe');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'discover_blender_installations') return delayedDiscovery;
      if (command === 'register_blender_installation') return manualInstallation;
      throw new Error(`unexpected command: ${command}`);
    });
    const service = await loadService();

    const detection = service.detectDirectorBlenderInstallation();
    await expect(service.chooseDirectorBlenderInstallation()).resolves.toEqual(manualInstallation);
    resolveDiscovery({ candidates: [installation] });

    await expect(detection).resolves.toEqual(manualInstallation);
    expect(service.getSelectedDirectorBlenderInstallation()).toEqual(manualInstallation);
  });

  it('候选不唯一时只通过系统对话框手选，并把路径交给用途单一的登记命令', async () => {
    const manualInstallation = {
      ...installation,
      installationId: 'blender-installation-manual',
      source: 'user-selected',
    };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'discover_blender_installations') {
        return { candidates: [installation, { ...installation, installationId: 'second' }] };
      }
      if (command === 'register_blender_installation') return manualInstallation;
      throw new Error(`unexpected command: ${command}`);
    });
    mocks.open.mockResolvedValue('F:\\Blender\\blender.exe');
    const service = await loadService();

    await expect(service.prepareDirectorBlenderInstallation()).resolves.toEqual(manualInstallation);

    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({
      directory: false,
      multiple: false,
      filters: [{ name: 'Blender', extensions: ['exe'] }],
    }));
    expect(mocks.invoke).toHaveBeenLastCalledWith('register_blender_installation', {
      request: { executablePath: 'F:\\Blender\\blender.exe' },
    });
  });

  it('按 grant -> start -> poll -> collect -> revoke 完成任务并投影原生结果', async () => {
    vi.useFakeTimers();
    mocks.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'discover_blender_installations':
          return { candidates: [installation] };
        case 'create_blender_project_grant':
          return { projectGrantId: 'grant-1' };
        case 'start_blender_job':
          return jobStatus('running');
        case 'get_blender_job_status':
          return jobStatus('awaiting-collection');
        case 'collect_blender_job_result':
          return collectedResult();
        case 'revoke_blender_project_grant':
          return undefined;
        default:
          throw new Error(`unexpected command: ${command}`);
      }
    });
    const service = await loadService();

    const operation = service.runDirectorBlenderOperation(renderFrameInput());
    await vi.advanceTimersByTimeAsync(300);
    const result = await operation;

    expect(commandNames()).toEqual([
      'discover_blender_installations',
      'create_blender_project_grant',
      'start_blender_job',
      'get_blender_job_status',
      'collect_blender_job_result',
      'revoke_blender_project_grant',
    ]);
    expect(result.frame).toMatchObject({
      filePath: `G:/project-data/director/scenes/scene-main/results/frame-a-${ARTIFACT_HASH}.png`,
      fileName: `frame-a-${ARTIFACT_HASH}.png`,
      mediaUrl:
        `asset://localhost/G:/project-data/director/scenes/scene-main/results/frame-a-${ARTIFACT_HASH}.png`,
    });
  });

  it('单帧任务只提交固定字段和 targetFrame，不向 Rust 暴露自由路径或执行参数', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'discover_blender_installations':
          return { candidates: [installation] };
        case 'create_blender_project_grant':
          return { projectGrantId: 'grant-1' };
        case 'start_blender_job':
          return jobStatus('awaiting-collection');
        case 'collect_blender_job_result':
          return collectedResult();
        case 'revoke_blender_project_grant':
          return undefined;
        default:
          throw new Error(`unexpected command: ${command}`);
      }
    });
    const service = await loadService();

    await service.runDirectorBlenderOperation(renderFrameInput(73));

    const startCall = mocks.invoke.mock.calls.find(([command]) => command === 'start_blender_job');
    expect(startCall).toBeDefined();
    const request = (startCall?.[1] as { request: Record<string, unknown> }).request;
    expect(request.targetFrame).toBe(73);
    expect(Object.keys(request).sort()).toEqual([
      'directorInstanceId',
      'installationId',
      'operation',
      'previousManifestRevision',
      'previousManifestSha256',
      'projectGrantId',
      'projectId',
      'sceneId',
      'sceneRevision',
      'sceneSha256',
      'targetFrame',
    ].sort());
    for (const forbidden of ['path', 'projectRoot', 'python', 'script', 'args', 'argv', 'cwd', 'env']) {
      expect(request).not.toHaveProperty(forbidden);
    }
  });

  it('Abort 会取消已启动 Job，并且始终撤销项目 grant', async () => {
    vi.useFakeTimers();
    mocks.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'discover_blender_installations':
          return { candidates: [installation] };
        case 'create_blender_project_grant':
          return { projectGrantId: 'grant-1' };
        case 'start_blender_job':
          return jobStatus('running');
        case 'cancel_blender_job':
        case 'revoke_blender_project_grant':
          return undefined;
        case 'get_blender_job_status':
          return jobStatus('running');
        default:
          throw new Error(`unexpected command: ${command}`);
      }
    });
    const service = await loadService();
    const controller = new AbortController();
    const operation = service.runDirectorBlenderOperation(renderFrameInput(), {
      signal: controller.signal,
    });
    const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' });

    await flushPromiseChain();
    expect(commandNames()).toContain('start_blender_job');
    controller.abort();
    await vi.advanceTimersByTimeAsync(300);

    await rejection;
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_blender_job', {
      request: { jobId: 'blender-job-1' },
    });
    expect(mocks.invoke).toHaveBeenCalledWith('revoke_blender_project_grant', {
      request: { projectGrantId: 'grant-1' },
    });
    expect(commandNames().indexOf('cancel_blender_job'))
      .toBeLessThan(commandNames().indexOf('revoke_blender_project_grant'));
    expect(commandNames()).not.toContain('collect_blender_job_result');
  });

  it('原生 Job 报错时仍撤销项目 grant', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'discover_blender_installations':
          return { candidates: [installation] };
        case 'create_blender_project_grant':
          return { projectGrantId: 'grant-1' };
        case 'start_blender_job':
          return jobStatus('failed', { code: 'render-failed', message: '固定渲染任务失败' });
        case 'revoke_blender_project_grant':
          return undefined;
        default:
          throw new Error(`unexpected command: ${command}`);
      }
    });
    const service = await loadService();

    await expect(service.runDirectorBlenderOperation(renderFrameInput()))
      .rejects.toThrow('固定渲染任务失败');

    expect(commandNames().at(-1)).toBe('revoke_blender_project_grant');
  });

  it('结果与启动场景绑定不一致时拒绝回写，但仍撤销项目 grant', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'discover_blender_installations':
          return { candidates: [installation] };
        case 'create_blender_project_grant':
          return { projectGrantId: 'grant-1' };
        case 'start_blender_job':
          return jobStatus('awaiting-collection');
        case 'collect_blender_job_result':
          return collectedResult({ sceneSha256: 'e'.repeat(64) });
        case 'revoke_blender_project_grant':
          return undefined;
        default:
          throw new Error(`unexpected command: ${command}`);
      }
    });
    const service = await loadService();

    await expect(service.runDirectorBlenderOperation(renderFrameInput()))
      .rejects.toThrow(/Scene|场景|匹配/);

    expect(commandNames()).toContain('collect_blender_job_result');
    expect(commandNames().at(-1)).toBe('revoke_blender_project_grant');
  });

  it('保留 Tauri 字符串错误，且清理失败不会覆盖主错误', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'discover_blender_installations':
          return { candidates: [installation] };
        case 'create_blender_project_grant':
          return { projectGrantId: 'grant-1' };
        case 'start_blender_job':
          throw 'Blender 安装候选不存在或已失效';
        case 'revoke_blender_project_grant':
          throw 'Blender 项目授权撤销失败';
        default:
          throw new Error(`unexpected command: ${command}`);
      }
    });
    const service = await loadService();

    await expect(service.runDirectorBlenderOperation(renderFrameInput()))
      .rejects.toThrow('Blender 安装候选不存在或已失效');

    expect(commandNames().at(-1)).toBe('revoke_blender_project_grant');
  });
});
