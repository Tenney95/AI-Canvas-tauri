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
  signal?: AbortSignal;
}

export interface SubmittedModelProtocol {
  urls?: string[];
  text?: string;
  poll?: ResolvedModelProtocolPoll;
  taskId?: string;
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
