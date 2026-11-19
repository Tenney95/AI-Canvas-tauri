/** 主窗口关闭前等待已打开工作台处理草稿。注册只保存运行时回调。 */
let prepare: (() => Promise<boolean>) | undefined;

export function registerScriptWorkbenchAppClose(handler: () => Promise<boolean>): () => void {
  prepare = handler;
  return () => { if (prepare === handler) prepare = undefined; };
}

export function prepareScriptWorkbenchAppClose(): Promise<boolean> {
  return prepare?.() ?? Promise.resolve(true);
}
