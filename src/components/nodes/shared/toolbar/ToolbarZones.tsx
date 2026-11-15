import type { ReactNode } from 'react';
import type { ToolbarButtonDef, ToolbarLayout } from '../../../../types';
import ToolbarMoreMenu from './ToolbarMoreMenu';
import { TOOLBAR_MORE_KEY } from './toolbarRegistry';

interface ToolbarZonesProps {
  zones: ToolbarLayout['zones'];
  hiddenButtons: ToolbarButtonDef[];
  renderButton: (key: string) => ReactNode;
  dividerClassName?: string;
}

/** 只共享正常态分区；按钮业务、编辑态和弹窗仍由各节点管理。 */
export default function ToolbarZones({
  zones,
  hiddenButtons,
  renderButton,
  dividerClassName = 'ftb-divider img-toolbar-main-divider',
}: ToolbarZonesProps) {
  return zones.map((zone, index) => (
    <div key={zone.id} className="img-toolbar-zone nodrag">
      {zone.buttonKeys.map((key) => key === TOOLBAR_MORE_KEY
        ? <ToolbarMoreMenu key={key} items={hiddenButtons} renderItem={renderButton} />
        : renderButton(key))}
      {index < zones.length - 1 && <div className={dividerClassName} />}
    </div>
  ));
}
