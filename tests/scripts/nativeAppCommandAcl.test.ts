import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Capability {
  identifier: string;
  windows?: string[];
  webviews?: string[];
  local?: boolean;
  remote?: { urls: string[] };
  permissions: Array<string | { identifier: string }>;
}

const capabilitiesDirectory = new URL('../../src-tauri/capabilities/', import.meta.url);
const capabilities = readdirSync(capabilitiesDirectory)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(
    readFileSync(new URL(name, capabilitiesDirectory), 'utf8'),
  ) as Capability);
const firstPartyPermission = 'allow-first-party-app-commands';
const permissionId = (entry: Capability['permissions'][number]) => (
  typeof entry === 'string' ? entry : entry.identifier
);

describe('native application command ACL configuration', () => {
  it('preserves the existing first-party window grants without remote or wildcard scope', () => {
    const capability = capabilities.find((entry) => entry.identifier === 'default');
    expect(capability).toBeDefined();
    expect(capability?.windows).toEqual([
      'main', 'asset-search', 'chat-assistant', 'video-editor', 'style-guide',
    ]);
    expect(capability?.permissions.map(permissionId)).toContain(firstPartyPermission);
    expect(capability?.webviews).toBeUndefined();
    expect(capability?.remote).toBeUndefined();
    expect(capability?.local).not.toBe(false);
  });

  it('does not grant the first-party command set to another capability', () => {
    expect(capabilities
      .filter((entry) => entry.permissions.some((permission) => permissionId(permission) === firstPartyPermission))
      .map((entry) => entry.identifier)).toEqual(['default']);
  });

  it('gives native plugin webviews only the dedicated session bridge', () => {
    const capability = capabilities.find((entry) => entry.identifier === 'plugin-ui-window');
    expect(capability?.webviews).toEqual(['plugin-window-*']);
    expect(capability?.windows).toBeUndefined();
    expect(capability?.remote).toBeUndefined();
    expect(capability?.local).not.toBe(false);
    expect(capability?.permissions).toEqual(['allow-plugin-ui-window-request']);
    for (const other of capabilities.filter((entry) => entry !== capability)) {
      expect([...(other.windows ?? []), ...(other.webviews ?? [])]).not.toContain('*');
      expect([...(other.windows ?? []), ...(other.webviews ?? [])].some((label) => label.startsWith('plugin-window'))).toBe(false);
    }
    const bridgePermission = readFileSync(new URL('../../src-tauri/permissions/plugin-ui-window.toml', import.meta.url), 'utf8');
    expect(bridgePermission).toMatch(/commands\.allow\s*=\s*\["plugin_ui_window_request"\]/u);
    const firstParty = readFileSync(new URL('../../src-tauri/permissions/allow-first-party-app-commands.toml', import.meta.url), 'utf8');
    expect(firstParty).not.toContain('"plugin_ui_window_request"');
    for (const command of ['open_plugin_ui_window', 'close_plugin_ui_window', 'respond_plugin_ui_window_request']) {
      expect(firstParty).toContain(`"${command}"`);
      expect(bridgePermission).not.toContain(`"${command}"`);
    }
  });
});
