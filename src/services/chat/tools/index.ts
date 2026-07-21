import { registerCanvasAgentTools } from './canvasTools';
import { registerMediaAgentTools } from './mediaTools';
import { registerFileAgentTools } from './fileTools';
import { registerMemoryAgentTools } from './memoryTools';
import { registerPresetAgentTools } from './presetTools';
import { registerExpertAgentTools } from './expertTools';
import { registerProviderConfigAgentTools } from './providerConfigTools';

let registered = false;

/**
 * 注册应用内置 Agent 工具。React StrictMode 下也只执行一次。
 */
export function ensureAgentToolsRegistered(): void {
  if (registered) return;
  registerCanvasAgentTools();
  registerMediaAgentTools();
  registerFileAgentTools();
  registerMemoryAgentTools();
  registerPresetAgentTools();
  registerExpertAgentTools();
  registerProviderConfigAgentTools();
  registered = true;
}
