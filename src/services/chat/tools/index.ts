import { registerCanvasAgentTools } from './canvasTools';
import { registerMediaAgentTools } from './mediaTools';
import { registerWebAgentTools } from './webTools';

let registered = false;

/**
 * 注册应用内置 Agent 工具。React StrictMode 下也只执行一次。
 */
export function ensureAgentToolsRegistered(): void {
  if (registered) return;
  registerCanvasAgentTools();
  registerMediaAgentTools();
  registerWebAgentTools();
  registered = true;
}
