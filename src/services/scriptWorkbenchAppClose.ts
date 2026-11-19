/** 主窗口卸载工作台前等待处理草稿。注册只保存运行时回调。 */
export type ScriptWorkbenchExitTarget = 'app' | 'start';
let prepare: ((target: ScriptWorkbenchExitTarget) => Promise<boolean>) | undefined;

export function registerScriptWorkbenchAppClose(handler: (target: ScriptWorkbenchExitTarget) => Promise<boolean>): () => void {
  prepare = handler;
  return () => { if (prepare === handler) prepare = undefined; };
}

export function prepareScriptWorkbenchAppClose(): Promise<boolean> {
  return prepare?.('app') ?? Promise.resolve(true);
}

export function prepareScriptWorkbenchStartPage(): Promise<boolean> | undefined {
  return prepare?.('start');
}
