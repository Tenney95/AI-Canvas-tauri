import { useEffect, useRef, useState } from 'react';
import MentionPicker from '../shared/MentionPicker';
import ModelPicker, { type ModelPickerGroup } from '../shared/ModelPicker';
import { buildReferenceChipEl } from '../shared/referenceChipDom';
import { getNodeChipIconPath } from '../nodes/shared/mentionEditorDom';
import referenceDemoImage from '../../assets/images/styles/realistic.webp';
import referenceDemoImageAlt from '../../assets/images/styles/cinematic.webp';

export function ReferenceChipsDemo() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = root.current; if (!container) return;
    const doc = container.ownerDocument;
    container.replaceChildren(
      buildReferenceChipEl(doc, { label: '原片视频', kind: 'video', badge: '#19', mediaIndex: '(视频1)', iconPath: getNodeChipIconPath('ai-video') }),
      buildReferenceChipEl(doc, { label: '参考音频', kind: 'audio', badge: '#30', mediaIndex: '(音频1)', iconPath: getNodeChipIconPath('ai-audio') }),
      buildReferenceChipEl(doc, { label: '图像参考', kind: 'image', badge: '#14', mediaIndex: '(图1)', thumbnailUrl: referenceDemoImage }),
      buildReferenceChipEl(doc, { label: '文本内容', kind: 'text', badge: '#13', iconPath: getNodeChipIconPath('ai-text') }),
      buildReferenceChipEl(doc, { label: '场景参考', kind: 'image', badge: '#18', mediaIndex: '(图2)', thumbnailUrl: referenceDemoImageAlt }),
      buildReferenceChipEl(doc, { label: '很长的引用名称会自动截断，完整名称保留在提示中', kind: 'text', iconPath: getNodeChipIconPath('ai-text') }),
    );
    return () => container.replaceChildren();
  }, []);
  return <div ref={root} className="ui-row" />;
}

export function ExpandableSearchDemo() {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState('nodes');
  const resources = [
    { key: 'demo-video', label: '参考视频.mp4', icon: 'lucide:video', badge: '自身' },
    { key: 'demo-image', label: '角色参考.png', thumbnailUrl: referenceDemoImage, badge: '#39' },
    { key: 'demo-text', label: '三镜脚本', icon: 'lucide:file-text', badge: '#13' },
    { key: 'demo-audio', label: '角色对白.wav', icon: 'lucide:volume-2', badge: '#30' },
    { key: 'demo-character', label: '角色 · 月下剑客', icon: 'lucide:user' },
    { key: 'demo-scene', label: '场景 · 湖心码头', icon: 'lucide:image' },
    { key: 'demo-prop', label: '道具 · 青铜灯笼', icon: 'lucide:box' },
  ];
  const candidates = expanded ? resources : activeTab === 'nodes' ? resources.slice(0, 2) : resources.slice(4);
  const items = candidates.filter((item) => `${item.badge ?? ''} ${item.label}`.includes(query.trim()))
    .map((item) => ({ ...item, onSelect: () => setQuery(item.label) }));
  return <div className="ui-stack ui-stack--tight max-w-lg">
    <MentionPicker tabs={[{ id: 'nodes', label: '输入图', icon: 'lucide:images' },
      { id: 'assets', label: '资产库', icon: 'lucide:library' }]}
      activeTab={activeTab} onTabChange={setActiveTab} items={items} ariaLabel="引用搜索示例"
      search={{ expanded, onExpandedChange: setExpanded, value: query, onChange: setQuery }}
      footer={<span className="ui-hint">引用资产</span>} />
    <p className="ui-hint">页签与搜索共用外框；输入框向左展开，页签向左移出，资源增减时高度同步过渡。Esc 清空并收起，示例不读取项目资源。</p>
  </div>;
}

export function ModelPickerDemo({ groups }: { groups: ModelPickerGroup[] }) {
  const [value, setValue] = useState('demo-seedance');
  return <div className="ui-stack ui-stack--tight max-w-lg">
    <ModelPicker groups={groups} value={value} onChange={setValue}
      defaultExpandedGroupIds={['volcengine']} aria-label="公共模型选择示例" />
    <p className="ui-hint">展开厂商后选择模型；方向键浏览，左右键展开或收起，Esc 关闭。示例只更新本地展示。</p>
  </div>;
}
