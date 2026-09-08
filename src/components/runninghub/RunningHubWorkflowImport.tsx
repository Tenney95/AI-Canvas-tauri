import { useEffect, useRef, useState } from 'react';
import { generateId, useAppStore } from '../../store/useAppStore';
import type { WorkflowCategory, WorkflowDefinition } from '../../types';
import type { RunningHubConnectionId, RunningHubParameter, RunningHubWorkflowManifest } from '../../types/runninghub';
import { fetchRunningHubDefinition, importRunningHubDefinition, runningHubFieldValue, runningHubParameterKey, validateRunningHubManifest } from '../../services/runninghubWorkflowService';
import { runningHubConnection } from '../../services/workflowExecutionService';
import RunningHubParameterFields from '../nodes/shared/RunningHubParameterFields';

export default function RunningHubWorkflowImport({ kind, editing, onSaved }: {
  kind: 'workflow' | 'app'; editing?: WorkflowDefinition; onSaved: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [category, setCategory] = useState<WorkflowCategory>(editing?.category ?? 'ai-image');
  const [remoteId, setRemoteId] = useState(editing?.runninghub?.remoteId ?? '');
  const [connectionId, setConnectionId] = useState<RunningHubConnectionId>(editing?.runninghub?.connectionId ?? 'runninghub');
  const [definition, setDefinition] = useState('');
  const [manifest, setManifest] = useState<RunningHubWorkflowManifest | undefined>(editing?.runninghub);
  const [defaultInputs, setDefaultInputs] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const setField = (index: number, patch: Partial<RunningHubParameter>) => setManifest((current) => current && ({ ...current, parameters: current.parameters.map((field, i) => i === index ? { ...field, ...patch } : field) }));
  async function readDefinition(remote: boolean) {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setMessage('');
    try {
      const options = { kind, remoteId, connectionId };
      const next = remote
        ? await fetchRunningHubDefinition(runningHubConnection(useAppStore.getState().config.providers, connectionId), options, controller.signal)
        : importRunningHubDefinition(definition, options);
      if (controller.signal.aborted) return;
      setManifest(next); setDefaultInputs({}); setRemoteId(next.remoteId); setDefinition('');
      setMessage(`已读取 ${next.parameters.length} 个参数。请核对提示词与参考素材映射后保存。`);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : '读取定义失败');
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function save() {
    if (!manifest) return;
    setBusy(true); setMessage('');
    try {
      if (!name.trim()) throw new Error('请填写工作流名称');
      const next = { ...manifest, connectionId, parameters: manifest.parameters.map((field) => ({ ...field, defaultValue: runningHubFieldValue({ ...field, required: false }, defaultInputs[runningHubParameterKey(field)]) })) };
      validateRunningHubManifest(next);
      const changes = { name: name.trim(), category, adapterType: 'runninghub' as const, runninghub: next, fileName: `RunningHub ${kind === 'app' ? 'AI 应用' : '工作流'} · ${next.remoteId}`, fileContent: '', ioNodes: [], updatedAt: Date.now() };
      if (editing) await useAppStore.getState().updateWorkflow(editing.id, changes);
      else await useAppStore.getState().addWorkflow({ ...changes, id: generateId(), createdAt: Date.now() });
      setMessage('已保存，可在对应媒体节点的工作流菜单中选择'); onSaved();
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  }
  return <div className="flex min-w-0 flex-col gap-3">
    <p className="text-xs leading-relaxed text-canvas-text-secondary">读取定义不会生成素材。保存后，在图像、视频或音频节点中选择此工作流。</p>
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs">名称<input className="ui-input w-full" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
      <div className="flex flex-wrap gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">输出类型<select className="ui-select__control w-full" value={category} onChange={(event) => setCategory(event.target.value as WorkflowCategory)}>
          <option value="ai-image">图片</option><option value="ai-video">视频</option><option value="ai-audio">音频</option>
        </select></label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">使用连接<select className="ui-select__control w-full" value={connectionId} onChange={(event) => setConnectionId(event.target.value as RunningHubConnectionId)}>
          <option value="runninghub">工作流 API Key</option><option value="runninghub-model">模型 API Key</option>
        </select></label>
      </div>
      <label className="flex flex-col gap-1 text-xs">{kind === 'app' ? 'AI 应用' : '工作流'}链接或 ID<input className="ui-input w-full" value={remoteId} placeholder={kind === 'app' ? 'https://www.runninghub.cn/ai-detail/…' : 'https://www.runninghub.cn/workflow/…'} onChange={(event) => { setRemoteId(event.target.value); setManifest(undefined); }} /></label>
      <button type="button" className="ui-btn" disabled={!remoteId.trim()} onClick={() => { void readDefinition(true); }}>从 RunningHub 读取定义</button>
      <details className="ui-card p-3">
        <summary className="cursor-pointer text-xs">从官方 API JSON / 调用示例导入</summary>
        <div className="mt-2 flex flex-col gap-2">
          <textarea aria-label="API 定义" className="ui-textarea w-full" rows={5} value={definition} maxLength={1_500_000} placeholder="粘贴 API JSON 或 curl 调用示例；只提取参数，不保存鉴权信息" onChange={(event) => setDefinition(event.target.value)} />
          <input aria-label="导入 API JSON 文件" type="file" accept=".json,application/json" className="max-w-full text-xs" onChange={(event) => {
            const file = event.target.files?.[0]; if (!file) return;
            if (file.size > 1_500_000) { setMessage('定义超过 1.5 MB 限制'); return; }
            void file.text().then(setDefinition).catch(() => setMessage('读取文件失败'));
          }} />
          <button type="button" className="ui-btn" disabled={!definition.trim()} onClick={() => { void readDefinition(false); }}>解析并预览</button>
        </div>
      </details>
      {manifest && <>
        <div className="flex items-center justify-between gap-2 text-xs"><span>参数映射 · {manifest.parameters.length} 项</span><button type="button" className="ui-btn ui-btn--sm" onClick={() => setManifest({ ...manifest, parameters: [...manifest.parameters, { nodeId: '', fieldName: '', label: '新参数', type: 'string', defaultValue: '', source: 'value' }] })}>添加参数</button></div>
        <p className="text-xs text-canvas-text-secondary">保留固定值，或映射到本次提示词和参考素材。参考序号按各媒体类型分别计数。</p>
        <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
          {manifest.parameters.map((field, index) => <details key={index} className="ui-card shrink-0 p-3">
            <summary className="cursor-pointer break-words text-xs">{field.label} · {field.source === 'value' ? '固定值 / 可调整' : field.source === 'prompt' ? '提示词' : `${field.source} #${(field.referenceIndex ?? 0) + 1}`}</summary>
            <div className="mt-2 flex min-w-0 flex-col gap-2">
              <label className="text-xs">显示名称<input className="ui-input w-full" value={field.label} maxLength={160} onChange={(event) => setField(index, { label: event.target.value })} /></label>
              <div className="flex flex-wrap gap-2">
                <label className="min-w-0 flex-1 text-xs">节点 ID<input className="ui-input w-full" value={field.nodeId} onChange={(event) => setField(index, { nodeId: event.target.value })} /></label>
                <label className="min-w-0 flex-1 text-xs">字段名<input className="ui-input w-full" value={field.fieldName} onChange={(event) => setField(index, { fieldName: event.target.value })} /></label>
              </div>
              <label className="text-xs">输入来源<select className="ui-select__control w-full" value={field.source} onChange={(event) => setField(index, { source: event.target.value as RunningHubParameter['source'] })}>
                <option value="value">固定值 / 每次可调整</option>
                {field.type === 'string' && <><option value="prompt">本次提示词</option><option value="image">图片参考</option><option value="video">视频参考</option><option value="audio">音频参考</option></>}
              </select></label>
              {['image', 'video', 'audio'].includes(field.source) && <div className="flex flex-wrap gap-2">
                <label className="min-w-0 flex-1 text-xs">参考序号<input type="number" min={1} max={32} className="ui-input w-full" value={(field.referenceIndex ?? 0) + 1} onChange={(event) => setField(index, { referenceIndex: Number(event.target.value) - 1 })} /></label>
                <label className="min-w-0 flex-1 text-xs">上传后传入<select className="ui-select__control w-full" value={field.mediaFormat ?? 'filename'} onChange={(event) => setField(index, { mediaFormat: event.target.value as 'filename' | 'url' })}><option value="filename">文件名（LoadImage 等）</option><option value="url">URL（URL 输入节点）</option></select></label>
              </div>}
              <RunningHubParameterFields parameters={[{ ...field, source: 'value', label: `默认值 · ${field.type}` }]} values={defaultInputs} onChange={setDefaultInputs} />
              <div className="flex flex-wrap items-center justify-between gap-2"><label className="flex gap-2 text-xs"><input type="checkbox" checked={field.required ?? false} onChange={(event) => setField(index, { required: event.target.checked })} />必填</label><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => setManifest({ ...manifest, parameters: manifest.parameters.filter((_, i) => i !== index) })}>不覆盖此参数</button></div>
            </div>
          </details>)}
        </div>
        <label className="text-xs">限定输出节点（可选，逗号分隔）<input className="ui-input w-full" value={manifest.outputNodeIds?.join(', ') ?? ''} onChange={(event) => setManifest({ ...manifest, outputNodeIds: event.target.value.split(/[,，\s]+/).filter(Boolean) })} /></label>
        <label className="text-xs">实例<select className="ui-select__control w-full" value={manifest.instanceType ?? 'default'} onChange={(event) => setManifest({ ...manifest, instanceType: event.target.value as 'default' | 'plus' })}><option value="default">默认</option><option value="plus">Plus（可能增加费用）</option></select></label>
        {kind === 'workflow' && <label className="flex gap-2 text-xs"><input type="checkbox" checked={manifest.usePersonalQueue ?? false} onChange={(event) => setManifest({ ...manifest, usePersonalQueue: event.target.checked })} />使用个人队列</label>}
        <button type="button" className="ui-btn ui-btn--primary" onClick={() => { void save(); }}>{editing ? '保存修改' : '添加云工作流'}</button>
      </>}
    </fieldset>
    {(busy || message) && <p role="status" className="break-words text-xs leading-relaxed text-canvas-text-secondary">{busy ? '处理中…' : message}</p>}
  </div>;
}
