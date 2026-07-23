import { registerCanvasAgentTools } from './canvasTools';
import { registerMediaAgentTools } from './mediaTools';
import { registerFileAgentTools } from './fileTools';
import { registerMemoryAgentTools } from './memoryTools';
import { registerPresetAgentTools } from './presetTools';
import { registerExpertAgentTools } from './expertTools';
import { registerProviderConfigAgentTools } from './providerConfigTools';
import { registerWebAgentTools } from './webTools';

type AgentToolRegistrationFactory = () => Array<() => void>;

interface AgentToolsRegistrationState {
  factories?: AgentToolRegistrationFactory[];
  unregisters?: Array<() => void>;
}

const REGISTRATION_STATE_KEY = '__AI_CANVAS_AGENT_TOOLS_REGISTRATION__';
const registrationHost = globalThis as typeof globalThis & {
  [REGISTRATION_STATE_KEY]?: AgentToolsRegistrationState;
};

function getRegistrationState(): AgentToolsRegistrationState {
  registrationHost[REGISTRATION_STATE_KEY] ??= {};
  return registrationHost[REGISTRATION_STATE_KEY];
}

function getRegistrationFactories(): AgentToolRegistrationFactory[] {
  return [
    registerCanvasAgentTools,
    registerMediaAgentTools,
    registerFileAgentTools,
    registerMemoryAgentTools,
    registerPresetAgentTools,
    registerExpertAgentTools,
    registerProviderConfigAgentTools,
    registerWebAgentTools,
  ];
}

function sameFactories(
  left: AgentToolRegistrationFactory[] | undefined,
  right: AgentToolRegistrationFactory[],
): boolean {
  return !!left
    && left.length === right.length
    && left.every((factory, index) => factory === right[index]);
}

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
  const state = getRegistrationState();
  if (!state.unregisters) return;
  const unregisters = state.unregisters;
  state.factories = undefined;
  state.unregisters = undefined;
  unregisterAgentTools(unregisters);
}

/**
 * 注册应用内置 Agent 工具。React StrictMode 下只执行一次；HMR 更新前会完整注销。
 */
export function ensureAgentToolsRegistered(): void {
  const factories = getRegistrationFactories();
  const state = getRegistrationState();
  if (state.unregisters && sameFactories(state.factories, factories)) return;
  if (state.unregisters) disposeAgentToolsRegistration();

  const unregisters: Array<() => void> = [];
  try {
    for (const registerTools of factories) unregisters.push(...registerTools());
    state.factories = factories;
    state.unregisters = unregisters;
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
