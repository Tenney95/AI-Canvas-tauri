import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Select Portal 点击边界', () => {
  it('项目设置把 fixedMenu 的 Portal 菜单视为弹层内交互', () => {
    const selectSource = readFileSync(
      new URL('../../src/components/shared/Select.tsx', import.meta.url),
      'utf8',
    );
    const projectSettingsSource = readFileSync(
      new URL('../../src/components/ProjectSettingsPopover.tsx', import.meta.url),
      'utf8',
    );

    expect(selectSource).toContain("data-ui-select-portal={fixedMenu ? '' : undefined}");
    expect(projectSettingsSource).toContain("closest('[data-ui-select-portal]')");
  });
});
