/**
 * ko-KR 词条聚合：key 是源码里的中文原文，缺失时自动回落中文。
 * 按功能域拆分到各模块文件，新增模块在此处汇总。
 * 占位符沿用 `{name}` 语法，必须与源码中 t() 的第二个参数字段名一致。
 */
import canvas from './canvas';
import character from './character';
import chat from './chat';
import common from './common';
import nodes from './nodes';
import onboarding from './onboarding';
import project from './project';
import projectSettings from './projectSettings';
import series from './series';
import settings from './settings';
import videoEditor from './videoEditor';

const koKR: Record<string, string> = {
  ...canvas,
  ...character,
  ...chat,
  ...common,
  ...nodes,
  ...onboarding,
  ...project,
  ...projectSettings,
  ...series,
  ...settings,
  ...videoEditor,
};

export default koKR;
