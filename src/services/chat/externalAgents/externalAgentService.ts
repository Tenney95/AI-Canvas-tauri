import { CODEX_EXTERNAL_PROVIDER_ID, type ExternalAgentExecutionInput, type ExternalAgentResult } from '../../../types/externalAgent';
import { executeCodexAppServer, ExternalAgentExecutionError } from './codexAppServerAdapter';

export { getExternalAgentCatalog, getExternalAgentStatus, readExternalAgentCatalog } from './externalAgentRegistry';
export { ExternalAgentExecutionError } from './codexAppServerAdapter';

/** 团队 Runtime 的执行入口；主窗口仍独占任务、产物和正式写回。 */
export function executeExternalAgent(input: ExternalAgentExecutionInput): Promise<ExternalAgentResult> {
  if (input.providerId !== CODEX_EXTERNAL_PROVIDER_ID) return Promise.reject(new ExternalAgentExecutionError('CODEX_PROVIDER_UNSUPPORTED'));
  return executeCodexAppServer(input);
}
