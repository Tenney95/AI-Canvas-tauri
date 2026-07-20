import { Icon } from '@iconify/react';
import { useMemo, useState } from 'react';
import type { GeneralModelCategory } from '../../types';
import {
  analyzeModelProtocolExamples,
  type ModelProtocolImportConfidence,
  type ModelProtocolImportFormat,
  type ModelProtocolImportResult,
  type ModelProtocolExamples,
} from '../../services/ai/modelProtocolImport';
import AnimatedButton from '../shared/AnimatedButton';

interface ProtocolImportPanelProps {
  onApply: (result: ModelProtocolImportResult) => void;
  onClose: () => void;
}

const CATEGORY_LABELS: Record<GeneralModelCategory, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
};

const FORMAT_LABELS: Record<ModelProtocolImportFormat, string> = {
  fetch: 'Fetch',
  axios: 'Axios',
  curl: 'cURL',
  python: 'Python',
  'raw-http': 'Raw HTTP',
  openapi: 'OpenAPI JSON',
  json: 'JSON 响应',
};

const CONFIDENCE_LABELS: Record<ModelProtocolImportConfidence, string> = {
  high: '高置信度',
  medium: '需要检查',
  low: '低置信度',
};

const CONFIDENCE_CLASSES: Record<ModelProtocolImportConfidence, string> = {
  high: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
  medium: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
  low: 'border-red-500/25 bg-red-500/10 text-red-300',
};

const EMPTY_EXAMPLES: ModelProtocolExamples = {
  submitRequest: '',
  submitResponse: '',
  pollRequest: '',
  pollResponse: '',
};

interface ExampleEditorProps {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}

function ExampleEditor({ label, value, placeholder, onChange }: ExampleEditorProps) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-canvas-text-secondary">
        <Icon icon="mdi:code-json" width="14" className="text-canvas-text-muted" />
        {label}
      </span>
      <textarea
        value={value}
        rows={8}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        className="min-h-36 w-full resize-y rounded-md border border-canvas-border bg-canvas-bg/50 px-2.5 py-2 font-mono text-[12px] leading-relaxed text-canvas-text outline-none transition-colors placeholder:text-canvas-text-muted focus:border-indigo-400/60"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export default function ProtocolImportPanel({ onApply, onClose }: ProtocolImportPanelProps) {
  const [examples, setExamples] = useState<ModelProtocolExamples>(EMPTY_EXAMPLES);
  const [pollingEnabled, setPollingEnabled] = useState(false);
  const [result, setResult] = useState<ModelProtocolImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acceptedLowConfidence, setAcceptedLowConfidence] = useState(false);

  const canApply = !!result?.baseUrl
    && !!result.modelId
    && !!result.category
    && !!result.protocol
    && (result.confidence !== 'low' || acceptedLowConfidence);
  const protocolSummary = useMemo(() => {
    if (!result?.protocol) return '';
    const protocol = result.protocol;
    const lines = [`${protocol.submit.method} ${protocol.submit.path}`];
    if (protocol.mode === 'async' && protocol.poll) lines.push(`${protocol.poll.method} ${protocol.poll.path}`);
    return lines.join('  ->  ');
  }, [result]);
  const hasAnyExample = Object.values(examples).some((value) => !!value?.trim());
  const hasRequiredExamples = !!examples.submitRequest.trim()
    && !!examples.submitResponse.trim()
    && (!pollingEnabled || (!!examples.pollRequest?.trim() && !!examples.pollResponse?.trim()));

  const updateExample = (key: keyof ModelProtocolExamples, value: string) => {
    setExamples((current) => ({ ...current, [key]: value }));
    setResult(null);
    setError(null);
    setAcceptedLowConfidence(false);
  };

  const analyze = (category?: GeneralModelCategory) => {
    try {
      const nextResult = analyzeModelProtocolExamples({
        submitRequest: examples.submitRequest,
        submitResponse: examples.submitResponse,
        ...(pollingEnabled ? {
          pollRequest: examples.pollRequest,
          pollResponse: examples.pollResponse,
        } : {}),
      }, category ? { category } : undefined);
      setResult(nextResult);
      setError(null);
      setAcceptedLowConfidence(false);
    } catch (analysisError) {
      setResult(null);
      setError(analysisError instanceof Error ? analysisError.message : '接口文档解析失败');
      setAcceptedLowConfidence(false);
    }
  };

  const clear = () => {
    setExamples(EMPTY_EXAMPLES);
    setPollingEnabled(false);
    setResult(null);
    setError(null);
    setAcceptedLowConfidence(false);
  };

  return (
    <section
      className="mb-3 flex min-w-0 flex-col gap-3 border-y border-canvas-border bg-black/10 px-3 py-3 text-[12px]"
      aria-label="从接口文档导入"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-medium text-canvas-text">
            <Icon icon="mdi:file-import-outline" width="15" className="text-indigo-300" />
            从接口文档导入
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-canvas-text-muted">
            分别粘贴文档中的请求代码和响应 JSON，支持 Fetch、Axios、cURL、Python、Raw HTTP 与 OpenAPI JSON。
          </p>
        </div>
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-canvas-text-muted transition-colors hover:bg-white/[0.06] hover:text-canvas-text"
          aria-label="关闭接口文档导入"
          title="关闭"
          onClick={onClose}
        >
          <Icon icon="mdi:close" width="16" />
        </button>
      </div>

      <div className="flex min-w-0 flex-col gap-2.5 border-t border-canvas-border pt-3">
        <div className="flex items-center justify-between gap-2">
          <strong className="text-[12px] font-medium text-canvas-text">提交阶段</strong>
          <span className="text-[11px] text-canvas-text-muted">请求与响应均必填</span>
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-3 max-[700px]:grid-cols-1">
          <ExampleEditor
            label="提交请求示例"
            value={examples.submitRequest}
            placeholder="粘贴 Fetch、cURL、Python 或 Raw HTTP 请求..."
            onChange={(value) => updateExample('submitRequest', value)}
          />
          <ExampleEditor
            label="提交响应示例"
            value={examples.submitResponse}
            placeholder="粘贴提交接口返回的 JSON..."
            onChange={(value) => updateExample('submitResponse', value)}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-2.5 border-t border-canvas-border pt-3">
        <div className="flex w-fit items-center gap-2 text-canvas-text-secondary">
          <button
            type="button"
            role="switch"
            aria-label="包含异步轮询"
            aria-checked={pollingEnabled}
            className={`relative h-4 w-7 rounded-full transition-colors ${
              pollingEnabled ? 'bg-indigo-500/60' : 'bg-white/10'
            }`}
            onClick={() => {
              setPollingEnabled((enabled) => !enabled);
              setResult(null);
              setError(null);
              setAcceptedLowConfidence(false);
            }}
          >
            <span className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full transition-all ${
              pollingEnabled ? 'translate-x-3 bg-white' : 'bg-canvas-text-muted'
            }`} />
          </button>
          <span>包含异步轮询</span>
        </div>
        {pollingEnabled ? (
          <div className="grid min-w-0 grid-cols-2 gap-3 max-[700px]:grid-cols-1">
            <ExampleEditor
              label="轮询请求示例"
              value={examples.pollRequest ?? ''}
              placeholder="粘贴查询任务状态的请求代码..."
              onChange={(value) => updateExample('pollRequest', value)}
            />
            <ExampleEditor
              label="轮询响应示例"
              value={examples.pollResponse ?? ''}
              placeholder="粘贴任务完成时返回的 JSON..."
              onChange={(value) => updateExample('pollResponse', value)}
            />
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-canvas-text-muted">只在本地静态解析，不执行代码、不请求接口、不导入密钥</span>
        <div className="flex items-center gap-2">
          {hasAnyExample ? (
            <button
              type="button"
              className="h-7 rounded-md px-2.5 text-[12px] text-canvas-text-secondary hover:bg-white/[0.05] hover:text-canvas-text"
              onClick={clear}
            >
              清空
            </button>
          ) : null}
          <AnimatedButton
            type="button"
            className="provider-secondary-btn h-7"
            disabled={!hasRequiredExamples}
            onClick={() => analyze()}
          >
            <Icon icon="mdi:auto-fix" width="14" />
            识别文档
          </AnimatedButton>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/[0.07] px-2.5 py-2 text-red-300" role="alert">
          <Icon icon="mdi:alert-circle-outline" width="15" className="mt-0.5 shrink-0" />
          <span className="min-w-0 leading-relaxed">{error}</span>
        </div>
      ) : null}

      {result ? (
        <div className="flex min-w-0 flex-col gap-3" aria-live="polite">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-canvas-border pt-3">
            <span className={`rounded border px-1.5 py-0.5 text-[11px] ${CONFIDENCE_CLASSES[result.confidence]}`}>
              {CONFIDENCE_LABELS[result.confidence]}
            </span>
            {result.formats.map((format) => (
              <span key={format} className="rounded bg-white/[0.05] px-1.5 py-0.5 text-[11px] text-canvas-text-secondary">
                {FORMAT_LABELS[format]}
              </span>
            ))}
          </div>

          <div className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-2 max-[700px]:grid-cols-1">
            {result.fields.map((field) => (
              <div key={field.id} className="grid min-w-0 grid-cols-[88px_minmax(0,1fr)] items-start gap-2 border-b border-canvas-border/70 pb-2">
                <span className="text-canvas-text-muted">{field.label}</span>
                <code className="min-w-0 break-all font-mono text-canvas-text-secondary">
                  {field.id === 'category'
                    ? CATEGORY_LABELS[field.value as GeneralModelCategory] ?? field.value
                    : field.value}
                </code>
              </div>
            ))}
          </div>

          {result.category ? (
            <label className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-canvas-text-muted">模型分类</span>
              <select
                value={result.category}
                className="h-7 min-w-28 rounded-md border border-canvas-border bg-canvas-bg/60 px-2 text-[12px] text-canvas-text outline-none focus:border-indigo-400/60"
                onChange={(event) => analyze(event.target.value as GeneralModelCategory)}
              >
                {(Object.keys(CATEGORY_LABELS) as GeneralModelCategory[]).map((category) => (
                  <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>
                ))}
              </select>
            </label>
          ) : null}

          {protocolSummary ? (
            <div className="flex min-w-0 items-start gap-2 rounded-md bg-white/[0.025] px-2.5 py-2">
              <Icon icon="mdi:source-branch" width="15" className="mt-0.5 shrink-0 text-canvas-text-muted" />
              <code className="min-w-0 break-all font-mono text-canvas-text-secondary">{protocolSummary}</code>
            </div>
          ) : null}

          {result.warnings.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-1.5 border-l-2 border-amber-400/40 pl-2.5 text-amber-200/90">
              {result.warnings.map((warning) => <p key={warning} className="m-0 leading-relaxed">{warning}</p>)}
            </div>
          ) : null}

          {result.confidence === 'low' ? (
            <label className="flex cursor-pointer items-start gap-2 text-canvas-text-secondary">
              <input
                type="checkbox"
                checked={acceptedLowConfidence}
                className="mt-0.5 accent-indigo-500"
                onChange={(event) => setAcceptedLowConfidence(event.target.checked)}
              />
              <span>我已检查低置信度字段，确认将识别结果应用到当前草稿</span>
            </label>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-canvas-border pt-3">
            <span className="text-canvas-text-muted">应用后仍需保存厂商设置；现有 API Key 不会被覆盖</span>
            <AnimatedButton
              type="button"
              className="provider-primary-btn h-7"
              disabled={!canApply}
              onClick={() => result && onApply(result)}
            >
              <Icon icon="mdi:check" width="14" />
              应用识别结果
            </AnimatedButton>
          </div>
        </div>
      ) : null}
    </section>
  );
}
