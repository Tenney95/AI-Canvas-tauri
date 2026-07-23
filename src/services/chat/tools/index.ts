import { registerCanvasAgentTools } from './canvasTools';
import { registerMediaAgentTools } from './mediaTools';
import { registerFileAgentTools } from './fileTools';
import { registerMemoryAgentTools } from './memoryTools';
import { registerPresetAgentTools } from './presetTools';
import { registerExpertAgentTools } from './expertTools';
import { registerProviderConfigAgentTools } from './providerConfigTools';
import { registerWebAgentTools } from './webTools';

let activeUnregisters: Array<() => void> | undefined;

function unregisterAgentTools(unregisters: Array<() => void>): void {
  for (const unregister of unregisters.reverse()) {
    try {
      unregister();
    } catch (error) {
      console.error('[AgentTools] failed to unregister tool:', error);
    }
  }
}

function disposeAgentToolsRegistration(): void {
  if (!activeUnregisters) return;
  const unregisters = activeUnregisters;
  activeUnregisters = undefined;
  unregisterAgentTools(unregisters);
}

/**
 * 注册应用内置 Agent 工具。React StrictMode 下只执行一次；HMR 更新前会完整注销。
 */
export function ensureAgentToolsRegistered(): void {
  if (activeUnregisters) return;

  const unregisters: Array<() => void> = [];
  try {
    unregisters.push(...registerCanvasAgentTools());
    unregisters.push(...registerMediaAgentTools());
    unregisters.push(...registerFileAgentTools());
    unregisters.push(...registerMemoryAgentTools());
    unregisters.push(...registerPresetAgentTools());
    unregisters.push(...registerExpertAgentTools());
    unregisters.push(...registerProviderConfigAgentTools());
    unregisters.push(...registerWebAgentTools());
    activeUnregisters = unregisters;
  } catch (error) {
    unregisterAgentTools(unregisters);
    throw error;
  }
}

export function resetAgentToolsRegistrationForTests(): void {
  disposeAgentToolsRegistration();
}

if (import.meta.hot) {
  import.meta.hot.dispose(disposeAgentToolsRegistration);
}
