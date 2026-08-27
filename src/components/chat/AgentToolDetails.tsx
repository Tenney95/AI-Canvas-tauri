/**
 * chat/AgentToolDetails — Agent 工具调用详情折叠面板。
 * 展示工具调用的输入与结果快照（AgentToolDisplaySnapshot），标注每个字段的取值来源
 * （用户指定 / 项目默认 / 模型默认 / 有效值），并支持展开查看原始 JSON。
 */
import { useState } from 'react';
import { Icon } from '@iconify/react';
import type {
  AgentToolDisplaySnapshot,
  AgentToolDisplayValue,
} from '../../types/agent';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';

interface AgentToolDetailsProps {
  input?: AgentToolDisplaySnapshot;
  result?: AgentToolDisplaySnapshot;
  defaultExpanded?: boolean;
}

const SOURCE_LABELS = {
  user: '用户指定',
  project_default: '项目默认',
  model_default: '模型默认',
  resolved: '有效值',
} as const;

function formatValue(value: AgentToolDisplayValue | undefined, t: (k: string) => string): string {
  if (value === undefined || value === '') return t('未设置');
  if (typeof value === 'boolean') return value ? t('是') : t('否');
  return String(value);
}

function hasDisplay(display: AgentToolDisplaySnapshot | undefined): boolean {
  return !!display && Boolean(
    display.fields?.length
    || display.references?.length
    || display.entities?.length
    || display.changes?.length
    || display.note,
  );
}

export default function AgentToolDetails({
  input,
  result,
  defaultExpanded = false,
}: AgentToolDetailsProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const nodes = useAppStore((state) => state.nodes);
  // React SSR 使用 Store 初始快照；测试与独立窗口预渲染时仍应读取当前已加载节点。
  const currentNodes = nodes.length > 0 ? nodes : useAppStore.getState().nodes;
  if (!hasDisplay(input) && !hasDisplay(result)) return null;

  const references = [...(input?.references ?? []), ...(result?.references ?? [])];
  const entities = [...(input?.entities ?? []), ...(result?.entities ?? [])];
  const changes = [...(input?.changes ?? []), ...(result?.changes ?? [])];

  return (
    <div className="mt-1.5 rounded-md border border-canvas-border bg-canvas-card/80">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[11px] text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/40"
      >
        <Icon icon="mdi:tune-variant" width="13" />
        <span>{t('调用详情')}</span>
        <Icon
          icon={expanded ? 'mdi:chevron-up' : 'mdi:chevron-down'}
          width="14"
          className="ml-auto"
        />
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-canvas-border px-2 py-2 text-[11px] leading-[17px]">
          {input?.fields?.length ? (
            <div>
              <p className="mb-1 font-medium text-canvas-text-secondary">{t('参数')}</p>
              <dl className="space-y-0.5">
                {input.fields.map((field, index) => (
                  <div key={`${field.label}-${index}`} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
                    <dt className="text-canvas-text-muted">{field.label}</dt>
                    <dd className="min-w-0 break-words text-canvas-text-secondary">
                      {formatValue(field.value, t)}
                      {field.source && (
                        <span className="ml-1.5 text-[10px] text-canvas-text-muted">
                          {t(SOURCE_LABELS[field.source])}
                        </span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {references.length > 0 && (
            <div>
              <p className="mb-1 font-medium text-canvas-text-secondary">{t('参考素材')}</p>
              <div className="grid grid-cols-2 gap-1.5">
                {references.map((reference, index) => {
                  const node = reference.kind === 'node'
                    ? currentNodes.find((item) => item.id === reference.id)
                    : undefined;
                  const preview = node && reference.mediaKind === 'image'
                    ? node.data.imageUrl || node.data.thumbnailUrl
                    : node?.data.thumbnailUrl;
                  return (
                    <div
                      key={`${reference.kind}-${reference.id}-${index}`}
                      className="flex min-w-0 items-center gap-1.5 rounded border border-canvas-border bg-canvas-surface/60 p-1.5"
                    >
                      {preview ? (
                        <img
                          src={preview}
                          alt=""
                          className="h-9 w-9 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-canvas-hover text-canvas-text-muted">
                          <Icon
                            icon={reference.mediaKind === 'video'
                              ? 'mdi:video-outline'
                              : reference.mediaKind === 'audio'
                                ? 'mdi:music-note-outline'
                                : 'mdi:image-outline'}
                            width="16"
                          />
                        </span>
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-canvas-text-secondary">{reference.label}</span>
                        <span className="block truncate text-[10px] text-canvas-text-muted">
                          {reference.kind === 'node'
                            ? node ? reference.id : t('素材已不可用')
                            : t('用户上传素材')}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {entities.length > 0 && (
            <div>
              <p className="mb-1 font-medium text-canvas-text-secondary">{t('对象')}</p>
              <div className="space-y-1">
                {entities.map((entity, index) => (
                  <div key={`${entity.id ?? entity.title}-${index}`} className="rounded border border-canvas-border bg-canvas-surface/60 px-2 py-1.5">
                    <p className="break-words text-canvas-text-secondary">{entity.title}</p>
                    {entity.subtitle && <p className="text-canvas-text-muted">{entity.subtitle}</p>}
                    {entity.fields?.map((field, fieldIndex) => (
                      <p key={`${field.label}-${fieldIndex}`} className="text-canvas-text-muted">
                        {field.label}：<span className="text-canvas-text-secondary">{formatValue(field.value, t)}</span>
                      </p>
                    ))}
                    {entity.preview && (
                      <p className="mt-1 break-words border-t border-canvas-border pt-1 text-canvas-text-muted">
                        {entity.preview}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {changes.length > 0 && (
            <div>
              <p className="mb-1 font-medium text-canvas-text-secondary">{t('变更')}</p>
              <div className="space-y-1">
                {changes.map((change, index) => (
                  <div key={`${change.targetId}-${change.field}-${index}`} className="rounded border border-canvas-border bg-canvas-surface/60 px-2 py-1.5">
                    <p className="truncate text-canvas-text-secondary">
                      {change.targetLabel || change.targetId} · {change.field}
                    </p>
                    <p className="break-words text-canvas-text-muted">
                      {formatValue(change.before, t)}
                      <Icon icon="mdi:arrow-right" width="12" className="mx-1 inline" />
                      <span className="text-canvas-text-secondary">{formatValue(change.after, t)}</span>
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result?.fields?.length ? (
            <div>
              <p className="mb-1 font-medium text-canvas-text-secondary">{t('结果')}</p>
              <dl className="space-y-0.5">
                {result.fields.map((field, index) => (
                  <div key={`${field.label}-${index}`} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
                    <dt className="text-canvas-text-muted">{field.label}</dt>
                    <dd className="break-words text-canvas-text-secondary">{formatValue(field.value, t)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {(input?.note || result?.note) && (
            <p className="break-words text-canvas-text-muted">{result?.note || input?.note}</p>
          )}
        </div>
      )}
    </div>
  );
}
