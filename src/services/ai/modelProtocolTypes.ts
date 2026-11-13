/**
 * ai/modelProtocolTypes — 声明式模型协议的公共入参与返回类型。
 *
 * 单独成文件是为了让「请求构建 / 轮询 / 提交」三个模块都能引用同一批类型，
 * 而不需要通过 modelProtocol 入口互相 import 形成环。
 */
import type {
  ModelExecutionProtocol,
  NormalizedModelExecutionProtocol,
  ProtocolJsonValue,
  ResolvedModelProtocolPoll,
} from '../../types/aiTypes';

export type ModelProtocolVariables = Record<string, ProtocolJsonValue | undefined>;

export interface SubmitModelProtocolOptions {
  apiKey: string;
  baseUrl: string;
  protocol: ModelExecutionProtocol;
  variables: ModelProtocolVariables;
  /** 仅由厂商运行时提供的单次提交身份，不是可编辑协议变量。 */
  idempotencyKey?: string;
  /** 适配器可校验平台业务码，不改变传输和同源边界。 */
  validateResponse?: (payload: unknown) => void;
  /** 内置适配器仅在异步提交的业务校验后规范化任务身份，不进入可编辑协议或持久化配置。 */
  normalizeSubmitResponse?: (payload: unknown) => unknown;
  /** 原生恢复只投影查询实际依赖的安全字段；完整提交响应只在本次调用内存中存在。 */
  captureRecoveryContext?: (payload: unknown) => Record<string, unknown>;
  /** 受管输入的提交边界，在请求构造完成后、发送前调用。 */
  beforeSubmit?: () => void | Promise<void>;
  /** 避免记录包含私人素材与提示词的请求。 */
  sensitive?: boolean;
  signal?: AbortSignal;
}

export interface SubmittedModelProtocol {
  urls?: string[];
  text?: string;
  poll?: ResolvedModelProtocolPoll;
  taskId?: string;
  recoveryContext?: Record<string, unknown>;
}

export interface ExecuteModelProtocolOptions extends SubmitModelProtocolOptions {
  signal?: AbortSignal;
}

export type BuildModelProtocolRequestOptions = SubmitModelProtocolOptions & {
  signal?: AbortSignal;
};

export interface ExecuteModelProtocolResult {
  urls?: string[];
  text?: string;
  taskId?: string;
}

export interface BuiltModelProtocolRequest {
  url: string;
  init: RequestInit;
  protocol: NormalizedModelExecutionProtocol;
  renderedBody?: ProtocolJsonValue;
}

export interface ModelProtocolRequestPreview {
  method: string;
  relativeUrl: string;
  headers: Record<string, string>;
  body?: ProtocolJsonValue;
}
