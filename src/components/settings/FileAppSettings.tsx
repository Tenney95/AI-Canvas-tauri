/**
 * settings/FileAppSettings — 文件与应用设置子页。
 * 展示并配置项目数据目录、默认根目录与应用可执行文件目录，
 * 支持在系统文件管理器中打开这些目录，并监听磁盘变更事件刷新路径。
 */
import { useEffect, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useShallow } from 'zustand/react/shallow';
import {
  getAppExecutableDir,
  getBaseDir,
  getDefaultBaseDir,
  getProjectDataDir,
  openDirectoryInFileManager,
  PROJECT_DISK_CHANGED_EVENT,
} from '../../services/fileService';
import { useAppStore } from '../../store/useAppStore';
import {
  chooseDirectorBlenderInstallation,
  detectDirectorBlenderInstallation,
  type DirectorBlenderInstallationCandidate,
} from '../../services/directorBlenderRuntimeService';
import AnimatedButton from '../shared/AnimatedButton';
import { useT } from '../../i18n';

interface ExternalEditorRow {
  id: string;
  label: string;
  path?: string;
  description: string;
  onChoose: () => Promise<void>;
}

function formatBlenderInstallation(candidate: DirectorBlenderInstallationCandidate): string {
  const version = candidate.versionHint?.trim();
  if (!version || candidate.displayName.includes(version)) return candidate.displayName;
  return `${candidate.displayName} · ${version}`;
}

export default function FileAppSettings({ active }: { active: boolean }) {
  const t = useT();
  const { config, updateConfig, saveConfig, currentProjectId } = useAppStore(useShallow((state) => ({
    config: state.config,
    updateConfig: state.updateConfig,
    saveConfig: state.saveConfig,
    currentProjectId: state.currentProjectId,
  })));
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [defaultBaseDir, setDefaultBaseDir] = useState<string | null>(null);
  const [appExecutableDir, setAppExecutableDir] = useState<string | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [blenderInstallation, setBlenderInstallation] =
    useState<DirectorBlenderInstallationCandidate | null>(null);
  const [blenderLoading, setBlenderLoading] = useState(true);
  const [blenderError, setBlenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const refreshDirectories = () => {
      setDirLoading(true);
      Promise.all([
        currentProjectId ? getProjectDataDir(currentProjectId) : Promise.resolve(null),
        getDefaultBaseDir(),
        getAppExecutableDir(),
      ])
        .then(([nextProjectDir, nextDefaultBaseDir, nextAppExecutableDir]) => {
          if (cancelled) return;
          setProjectDir(nextProjectDir);
          setDefaultBaseDir(nextDefaultBaseDir);
          setAppExecutableDir(nextAppExecutableDir);
        })
        .catch(() => {
          if (cancelled) return;
          setProjectDir(null);
          setDefaultBaseDir(null);
          setAppExecutableDir(null);
        })
        .finally(() => {
          if (!cancelled) setDirLoading(false);
        });
    };
    refreshDirectories();
    window.addEventListener(PROJECT_DISK_CHANGED_EVENT, refreshDirectories);
    return () => {
      cancelled = true;
      window.removeEventListener(PROJECT_DISK_CHANGED_EVENT, refreshDirectories);
    };
  }, [active, currentProjectId]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void detectDirectorBlenderInstallation()
      .then((candidate) => {
        if (cancelled) return;
        setBlenderInstallation(candidate);
        setBlenderError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setBlenderInstallation(null);
        setBlenderError(error instanceof Error ? error.message : 'Blender 安装检测失败');
      })
      .finally(() => {
        if (!cancelled) setBlenderLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const chooseDirectory = async (
    title: string,
    patch: (path: string) => Record<string, string>,
  ) => {
    try {
      const selected = await openDialog({ directory: true, title });
      if (selected && typeof selected === 'string') {
        updateConfig(patch(selected));
        await saveConfig();
      }
    } catch {
      // 浏览器环境忽略
    }
  };

  const chooseApplication = async (
    title: string,
    name: string,
    patch: (path: string) => Record<string, string>,
  ) => {
    try {
      const selected = await openDialog({
        multiple: false,
        title,
        filters: [{ name, extensions: ['exe', 'app'] }],
      });
      if (selected && typeof selected === 'string') {
        updateConfig(patch(selected));
        await saveConfig();
      }
    } catch {
      // 浏览器环境忽略
    }
  };

  const chooseBlender = async () => {
    setBlenderLoading(true);
    setBlenderError(null);
    try {
      setBlenderInstallation(await chooseDirectorBlenderInstallation());
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        setBlenderError(error instanceof Error ? error.message : 'Blender 选择失败');
      }
    } finally {
      setBlenderLoading(false);
    }
  };

  const baseDataDir = config.baseDataDir;
  const editors: ExternalEditorRow[] = [
    {
      id: 'photoshop',
      label: 'Photoshop',
      path: config.photoshopPath,
      description: t('用于图片节点的「在 PS 中打开」'),
      onChoose: () => chooseApplication(t('选择 Photoshop.exe'), 'Photoshop', (photoshopPath) => ({ photoshopPath })),
    },
    {
      id: 'jianying',
      label: '剪映专业版',
      path: config.jianyingPath,
      description: t('用于视频节点的「在剪映中打开」'),
      onChoose: () => chooseApplication(t('选择剪映专业版'), '剪映专业版', (jianyingPath) => ({ jianyingPath })),
    },
    {
      id: 'premiere',
      label: 'Adobe Premiere Pro',
      path: config.premierePath,
      description: t('用于视频节点的「在 PR 中打开」'),
      onChoose: () => chooseApplication(t('选择 Adobe Premiere Pro'), 'Adobe Premiere Pro', (premierePath) => ({ premierePath })),
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-canvas-text mb-2">{t('文件保存位置')}</h3>
        <div className="bg-canvas-card border border-canvas-border rounded-lg p-2">
          <div className="mb-3">
            <div className="text-xs text-canvas-text-muted mb-1.5">{t('保存根目录')}</div>
            <div className="flex items-center gap-2">
              <div className={`flex-1 min-w-0 text-[11px] break-all rounded-md px-3 py-1.5 border border-canvas-border ${
                baseDataDir
                  ? 'text-canvas-text-secondary font-mono leading-relaxed bg-canvas-surface select-all'
                  : 'text-canvas-text-muted bg-canvas-surface italic'
              }`}>
                {baseDataDir || t('未设置（使用系统默认目录）')}
              </div>
              <AnimatedButton
                type="button"
                className="settings-save-btn shrink-0 text-xs"
                onClick={() => chooseDirectory(t('选择文件保存根目录'), (path) => ({ baseDataDir: path }))}
              >
                {baseDataDir ? t('更换') : t('选择文件夹')}
              </AnimatedButton>
            </div>
          </div>

          <div className="text-[11px] text-canvas-text-muted leading-relaxed mb-3">
            {t('文件保存为：')}<span className="text-canvas-text-secondary font-mono">{baseDataDir || t('系统目录')}/{'{项目ID}'}/...</span>
          </div>

          <div className="space-y-2 py-2 border-y border-canvas-border">
            {[
              [t('应用所在目录'), appExecutableDir],
              [t('默认存储目录'), defaultBaseDir],
            ].map(([label, path]) => (
              <div className="min-w-0" key={label}>
                <div className="text-xs text-canvas-text-muted mb-0.5">{label}</div>
                <div className={`text-[11px] break-all leading-relaxed select-all ${
                  path ? 'text-canvas-text-secondary font-mono' : 'text-canvas-text-muted italic'
                }`}>
                  {dirLoading ? t('加载中…') : path || t('仅在 Tauri 桌面环境中可用')}
                </div>
              </div>
            ))}
          </div>

          <div className="pt-2">
            {dirLoading ? (
              <div className="text-xs text-canvas-text-muted">{t('加载中…')}</div>
            ) : projectDir ? (
              <div className="space-y-2">
                <div className="flex items-start gap-2 min-w-0">
                  <svg className="shrink-0 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-canvas-text-muted mb-0.5">{t('当前项目目录')}</div>
                    <div className="text-[11px] text-canvas-text-secondary break-all font-mono leading-relaxed select-all">{projectDir}</div>
                  </div>
                </div>
                <AnimatedButton
                  type="button"
                  className="settings-save-btn"
                  onClick={async () => {
                    try {
                      const dir = baseDataDir || await getBaseDir();
                      if (dir) await openDirectoryInFileManager(dir);
                    } catch (error) {
                      console.warn('无法打开文件夹:', error);
                    }
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  {t('打开文件夹')}
                </AnimatedButton>
              </div>
            ) : (
              <div className="text-xs text-canvas-text-muted">{t('仅在 Tauri 桌面环境中可用')}</div>
            )}
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-canvas-text mb-2">{t('外部编辑器')}</h3>
        <div className="bg-canvas-card border border-canvas-border rounded-lg p-2 divide-y divide-canvas-border">
          {editors.map((editor) => (
            <div key={editor.id} className="py-2 first:pt-0 last:pb-0">
              <div className="text-xs text-canvas-text-muted mb-1.5">{editor.label}</div>
              <div className="flex items-center gap-2">
                <div className={`flex-1 min-w-0 text-[11px] break-all leading-relaxed rounded-md px-3 py-1.5 border border-canvas-border ${
                  editor.path
                    ? 'text-canvas-text-secondary font-mono bg-canvas-surface select-all'
                    : 'text-canvas-text-muted bg-canvas-surface italic'
                }`}>
                  {editor.path || t('未设置（自动检测）')}
                </div>
                <AnimatedButton
                  type="button"
                  className="settings-save-btn shrink-0 text-xs"
                  onClick={() => { void editor.onChoose(); }}
                >
                  {editor.path ? t('更换') : t('选择文件')}
                </AnimatedButton>
              </div>
              <p className="text-[11px] text-canvas-text-muted leading-relaxed mt-1.5">
                {editor.description}；{t('手动路径优先，未设置时自动检测常见安装位置')}
              </p>
            </div>
          ))}
          <div className="py-2 first:pt-0 last:pb-0">
            <div className="text-xs text-canvas-text-muted mb-1.5">Blender</div>
            <div className="flex items-center gap-2">
              <div className={`flex-1 min-w-0 text-[11px] break-words leading-relaxed rounded-md px-3 py-1.5 border border-canvas-border bg-canvas-surface ${
                blenderInstallation ? 'text-canvas-text-secondary' : 'text-canvas-text-muted italic'
              }`}>
                {blenderLoading
                  ? t('检测中…')
                  : blenderInstallation
                    ? formatBlenderInstallation(blenderInstallation)
                    : t('未检测到唯一安装，请选择 blender.exe')}
              </div>
              <AnimatedButton
                type="button"
                className="settings-save-btn shrink-0 text-xs"
                disabled={blenderLoading}
                onClick={() => { void chooseBlender(); }}
              >
                {blenderInstallation ? t('重新选择') : t('选择 Blender')}
              </AnimatedButton>
            </div>
            <p className="text-[11px] text-canvas-text-muted leading-relaxed mt-1.5">
              {t('用于 3D 导演台的高级编辑、当前帧截图和参考视频渲染；安装仅在当前运行会话登记，启动前会重新校验')}
            </p>
            {blenderError && (
              <p className="mt-1 text-[11px] leading-relaxed text-red-400" role="alert">
                {blenderError}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
