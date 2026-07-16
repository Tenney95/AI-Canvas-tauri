import { registerCanvasAgentTools } from './canvasTools';
import { registerMediaAgentTools } from './mediaTools';
import { registerWebAgentTools } from './webTools';
import { registerFileAgentTools } from './fileTools';
import { registerMemoryAgentTools } from './memoryTools';

let registered = false;

/**
 * 注册应用内置 Agent 工具。React StrictMode 下也只执行一次。
 */
export function ensureAgentToolsRegistered(): void {
  if (registered) return;
  registerCanvasAgentTools();
  registerMediaAgentTools();
  registerWebAgentTools();
  registerFileAgentTools();
  registerMemoryAgentTools();
  registered = true;
}
