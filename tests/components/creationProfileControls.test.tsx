import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreationProfile } from '../../src/types/creationProfile';
import CreationProfilePicker from '../../src/components/shared/creationProfiles/CreationProfilePicker';
import CreationProfileManager from '../../src/components/shared/creationProfiles/CreationProfileManager';

const host = vi.hoisted(() => ({ state: {} as Record<string, unknown>, preview: vi.fn(), save: vi.fn(), remove: vi.fn() }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: Object.assign((selector: (state: Record<string, unknown>) => unknown) => selector(host.state), { getState: () => host.state }) }));
vi.mock('../../src/services/creationProfiles/creationProfileService', () => ({ previewCreationProfileOption: host.preview,
  previewCreationProfile: host.preview, saveCreationProfile: host.save, removeCreationProfile: host.remove }));
vi.mock('../../src/services/fs/jsonFileTransfer', () => ({ readJsonTextFile: vi.fn(), exportJsonTextFile: vi.fn() }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) => isOpen ? <div>{children}</div> : null }));

beforeEach(() => {
  host.preview.mockReset(); host.save.mockReset(); host.remove.mockReset();
  host.state = { config: { creationProfiles: [{ schemaVersion: 1, id: 'team', version: '1.0.0', name: 'Safe team',
    pluginRefs: [], agentPackageRefs: [], skillRefs: [], contextPolicyRef: 'project-default' } satisfies CreationProfile] },
  installedPlugins: [], agentPackages: [], userSkills: [], agentPackageSkills: [] };
});

describe('creation profile controls', () => {
  it('renders only catalog choices without implicitly checking native state or applying configuration', () => {
    const change = vi.fn();
    const html = renderToStaticMarkup(<CreationProfilePicker projectId="p1" profiles={[{ id: 'team', name: 'Safe team', version: '1.0.0' }]} onChange={change} />);
    expect(html).toContain('Safe team');
    expect(change).not.toHaveBeenCalled();
    expect(host.preview).not.toHaveBeenCalled();
    expect(html).not.toContain('pluginRefs');
    expect(html).not.toContain('roleExecutors');
  });

  it('does not install, enable, preview or save capabilities when the manager opens', () => {
    const html = renderToStaticMarkup(<CreationProfileManager onClose={vi.fn()} />);
    expect(html).toContain('Safe team');
    expect(html).not.toContain('roleExecutors');
    expect(host.preview).not.toHaveBeenCalled();
    expect(host.save).not.toHaveBeenCalled();
    expect(host.remove).not.toHaveBeenCalled();
  });
});
