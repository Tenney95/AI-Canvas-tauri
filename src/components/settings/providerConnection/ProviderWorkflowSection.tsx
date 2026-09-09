import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../../../i18n';
import type { CloudWorkflowMediaKind, WorkflowApiDraft } from '../../../types/workflowApi';
import { createWorkflowApiDraft, validateDeclarativeWorkflowManifest } from '../../../services/workflowApi/workflowApiDefinition';
import { parseModelExecutionProtocol, resolveModelExecutionProfile } from '../../../services/ai/modelProtocol';
import ModelProtocolEditor from '../ModelProtocolEditor';
import { useAppStore } from '../../../store/useAppStore';

function WorkflowCard({ draft, onChange, onValidityChange }: {
  draft: WorkflowApiDraft; onChange: (draft: WorkflowApiDraft) => void; onValidityChange: (id: string, valid: boolean) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [protocolValid, setProtocolValid] = useState(true);
  const [definitionError, setDefinitionError] = useState('');
  const [definitionText, setDefinitionText] = useState(() => JSON.stringify({ references: draft.manifest.references, parameters: draft.manifest.parameters,
    prompt: draft.manifest.prompt, businessStatus: draft.manifest.businessStatus }, null, 2));
  const error = useMemo(() => {
    try { validateDeclarativeWorkflowManifest(draft.manifest); if (!draft.name.trim()) return t('请填写工作流名称'); return ''; }
    catch (cause) { return cause instanceof Error ? cause.message : t('工作流配置无效'); }
  }, [draft, t]);
  useEffect(() => { onValidityChange(draft.id, protocolValid && !definitionError && !error); }, [draft.id, protocolValid, definitionError, error, onValidityChange]);
  const protocol = useMemo(() => {
    try { return parseModelExecutionProtocol(draft.manifest.protocol); }
    catch { return null; }
  }, [draft.manifest.protocol]);
  const previewMedia = (kind: 'image' | 'video' | 'audio', extension: string) => Array.from({ length: Math.min(draft.manifest.references[kind]?.max ?? 0, 2) },
    (_, index) => `https://cdn.example/reference-${index + 1}.${extension}`);
  const imageUrls = previewMedia('image', 'png');
  const videoUrls = previewMedia('video', 'mp4');
  const audioUrls = previewMedia('audio', 'mp3');
  return <details className="ui-card p-3" open>
    <summary className="cursor-pointer text-sm font-medium">{draft.name || t('自定义工作流')}</summary>
    <div className="mt-3 flex flex-col gap-3">
      <div className="provider-fields-grid">
        <label className="provider-field"><span>{t('工作流名称')}</span><input value={draft.name} maxLength={120} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
        <label className="provider-field"><span>{t('输出类型')}</span><select className="ui-select__control" value={draft.manifest.outputKind} disabled={editing}
          onChange={(event) => onChange({ ...draft, manifest: { ...draft.manifest, outputKind: event.target.value as CloudWorkflowMediaKind } })}>
          <option value="image">{t('图片')}</option><option value="video">{t('视频')}</option><option value="audio">{t('音频')}</option>
        </select></label>
      </div>
      {protocol && <div className="break-all text-xs text-canvas-text-secondary">{protocol.submit.method} {protocol.submit.path}</div>}
      <button type="button" className="ui-btn ui-btn--secondary self-start" disabled={!protocol} onClick={() => { setEditing(!editing); setProtocolValid(true); }}>{t('编辑调用路径与参数映射')}</button>
      {editing && protocol && <ModelProtocolEditor workflowMode model={{ id: draft.id, name: draft.name, category: draft.manifest.outputKind, provider: 'workflow-api', executionProfile: { preset: 'custom', protocol: draft.manifest.protocol } }}
        initialPreviewVariables={{ model: draft.manifest.workflowId, prompt: '示例提示词', parameters: Object.fromEntries(Object.entries(draft.manifest.parameters).flatMap(([name, spec]) => spec.default === undefined ? [] : [[name, spec.default]])),
          imageUrls, referenceImageUrls: imageUrls, firstImage: imageUrls[0], lastImage: imageUrls.at(-1), videoUrls, referenceVideoUrls: videoUrls, referenceVideoUrl: videoUrls[0],
          audioUrls, referenceAudioUrls: audioUrls, audioUrl: audioUrls[0], referenceUrls: [...imageUrls, ...videoUrls, ...audioUrls] }}
        apiKey="" baseUrl="" onImageReferenceRequestModeChange={() => {}} onClose={() => { setEditing(false); setProtocolValid(true); }} onValidityChange={setProtocolValid}
        onChange={(profile) => { if (!profile) { setProtocolValid(false); return; } const next = resolveModelExecutionProfile(profile); if (next) onChange({ ...draft, manifest: { ...draft.manifest, protocol: next } }); }} />}
      <label className="provider-field"><span>{t('能力与参数 JSON')}</span>
        <textarea className="ui-textarea min-h-48 w-full font-mono text-xs" spellCheck={false} value={definitionText} onChange={(event) => {
          const text = event.target.value; setDefinitionText(text);
          try {
            const definition: unknown = JSON.parse(text);
            if (!definition || typeof definition !== 'object' || Array.isArray(definition)
              || Object.keys(definition).some((key) => !['references', 'parameters', 'prompt', 'businessStatus'].includes(key))) throw new Error(t('能力与参数 JSON 格式无效'));
            const next = { ...draft.manifest, prompt: undefined, businessStatus: undefined, ...definition };
            validateDeclarativeWorkflowManifest(next); setDefinitionError(''); onChange({ ...draft, manifest: next });
          } catch (cause) { setDefinitionError(cause instanceof Error ? cause.message : t('能力与参数 JSON 格式无效')); }
        }} />
      </label>
      <p className="text-xs text-canvas-text-secondary">{t('references 设置各类素材的 min/max；parameters 声明参数类型、默认值、范围和选项，使用 {{parameters.参数名}} 映射到请求。')}</p>
      {(error || definitionError) && <p role="alert" className="text-xs text-canvas-text-secondary">{definitionError || error}</p>}
    </div>
  </details>;
}

export default function ProviderWorkflowSection({ drafts, onChange, onValidityChange }: {
  drafts: WorkflowApiDraft[]; onChange: (drafts: WorkflowApiDraft[]) => void; onValidityChange: (valid: boolean) => void;
}) {
  const t = useT();
  const [validity, setValidity] = useState<Record<string, boolean>>({});
  const updateValidity = useCallback((id: string, valid: boolean) => setValidity((previous) => previous[id] === valid ? previous : { ...previous, [id]: valid }), []);
  useEffect(() => { onValidityChange(drafts.length > 0 && drafts.every((draft) => validity[draft.id] === true)); }, [drafts, validity, onValidityChange]);
  return <section className="provider-config-section flex flex-col gap-3">
    <div className="provider-section-heading"><div><h4>{t('工作流 API')}</h4><p>{t('按平台文档配置工作流，保存后可在对应类型的节点中选择。')}</p></div></div>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="ui-btn ui-btn--secondary" disabled={drafts.length >= 50} onClick={() => onChange([...drafts, createWorkflowApiDraft()])}>{t('添加自定义工作流')}</button>
      <button type="button" className="ui-btn ui-btn--secondary" disabled={drafts.length >= 50} onClick={() => onChange([...drafts, createWorkflowApiDraft('autodl')])}>{t('添加 AutoDL H3 模板')}</button>
    </div>
    {drafts.map((draft) => <div key={draft.id} className="flex flex-col gap-1">
      <WorkflowCard draft={draft} onValidityChange={updateValidity} onChange={(next) => onChange(drafts.map((item) => item.id === next.id ? next : item))} />
      {!useAppStore.getState().workflows.some((workflow) => workflow.id === draft.id) && <button type="button" className="ui-btn ui-btn--sm self-end" onClick={() => onChange(drafts.filter((item) => item.id !== draft.id))}>{t('移除未保存的工作流')}</button>}
    </div>)}
    <p className="text-xs text-canvas-text-secondary">{t('本地素材先上传为临时公网 URL，再按 imageUrls、videoUrls、audioUrls 的数组或编号变量发送；未提供的编号字段自动省略。')}</p>
  </section>;
}
