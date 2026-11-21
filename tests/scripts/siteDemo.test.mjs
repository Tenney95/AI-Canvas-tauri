import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';

const script = readFileSync(new URL('../../site/demo/demo.js', import.meta.url), 'utf8');
const demoId = 'aicanvas-web-demo';
const fixture = JSON.parse(readFileSync(new URL('../../site/demo/canvas.json', import.meta.url), 'utf8'));
const lastActive = { id: 'last-active-project', projectId: 'another-project' };
const siteUrl = 'https://example.test/AI-Canvas-tauri/';

async function openTrialDatabase(indexedDB, previousProject, previousSummary) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-canvas-db', 27);
    request.onupgradeneeded = () => {
      const db = request.result;
      const projects = db.createObjectStore('projects', { keyPath: 'id' });
      const summaries = db.createObjectStore('projectSummaries', { keyPath: 'id' });
      db.createObjectStore('metadata', { keyPath: 'id' }).put(lastActive);
      if (previousProject) projects.put(previousProject);
      if (previousSummary) summaries.put(previousSummary);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function startTrialScript(indexedDB) {
  const opened = [];
  const tryButton = new EventTarget();
  const exitButton = Object.assign(new EventTarget(), { hidden: true });
  const stage = {
    appendChild(frame) {
      opened.push(frame.src);
      queueMicrotask(() => frame.dispatchEvent(new Event('load')));
    },
    querySelectorAll: () => [],
  };
  runInNewContext(script, {
    indexedDB,
    URL,
    fetch: async () => ({ ok: true, json: async () => fixture }),
    setTimeout: vi.fn(),
    document: {
      baseURI: siteUrl,
      createElement: () => Object.assign(new EventTarget(), { remove: vi.fn() }),
      getElementById: (id) => ({
        shot: { querySelector: () => stage, classList: { add: vi.fn(), remove: vi.fn() } },
        tryBtn: tryButton,
        demoExit: exitButton,
      })[id],
    },
  });
  return {
    opened,
    async open() {
      tryButton.dispatchEvent(new Event('click'));
      await vi.waitFor(() => expect(exitButton.hidden).toBe(false));
    },
    close: () => exitButton.dispatchEvent(new Event('click')),
  };
}

function readTrialData(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['projects', 'projectSummaries', 'metadata']);
    const project = tx.objectStore('projects').get(demoId);
    const summary = tx.objectStore('projectSummaries').get(demoId);
    const active = tx.objectStore('metadata').get(lastActive.id);
    tx.oncomplete = () => resolve({ project: project.result, summary: summary.result, active: active.result });
    tx.onabort = () => reject(tx.error);
  });
}

it('在提交演示项目及摘要后打开演示画布，并保留上次活动项目', async () => {
  const indexedDB = new IDBFactory();
  const db = await openTrialDatabase(indexedDB);
  try {
    const trial = startTrialScript(indexedDB);
    await trial.open();
    expect(trial.opened).toEqual([`app/?demoProject=${demoId}`]);
    const { project, summary, active } = await readTrialData(db);
    expect(project).toMatchObject({ id: demoId, name: fixture.name, edges: fixture.edges });
    expect(project.nodes.map((node) => node.id)).toEqual(fixture.nodes.map((node) => node.id));
    expect(project.nodes.map((node) => node.data.imageUrl).filter(Boolean)).toEqual([
      'char-elder', 'char-guard', 'char-envoy', 'scene-peak', 'scene-gate', 'storyboard-3x3',
    ].map((name) => `${siteUrl}demo/${name}.png`));
    expect(summary).toEqual({
      id: demoId, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, dataFolder: 'web-demo',
    });
    expect(active).toEqual(lastActive);
  } finally {
    db.close();
  }
});

it('仅迁移原内置节点的 SVG 引用，并保留用户素材和已有摘要', async () => {
  const indexedDB = new IDBFactory();
  const originalSvg = '../demo/char-elder.svg';
  const previous = {
    id: demoId, name: '旧版演示', createdAt: 12, updatedAt: 23, dataFolder: 'web-demo',
    nodes: [
      { id: 'demo-char-elder', data: { imageUrl: originalSvg, prompt: '自定义提示词' } },
      { id: 'demo-char-guard', data: { imageUrl: 'https://example.test/user-image.png' } },
      { id: 'duplicate', data: { imageUrl: originalSvg } },
    ],
    edges: [{ id: 'saved-edge' }],
  };
  const summary = { id: demoId, name: previous.name, createdAt: 12, updatedAt: 23, dataFolder: 'web-demo', parentId: 'edited-series' };
  const db = await openTrialDatabase(indexedDB, previous, summary);
  try {
    const trial = startTrialScript(indexedDB);
    await trial.open();
    const migrated = await readTrialData(db);
    expect(migrated).toEqual({
      project: {
        ...previous,
        nodes: [
          { id: 'demo-char-elder', data: { imageUrl: `${siteUrl}demo/char-elder.png`, prompt: '自定义提示词' } },
          ...previous.nodes.slice(1),
        ],
      },
      summary,
      active: lastActive,
    });
    trial.close();
    await trial.open();
    expect(await readTrialData(db)).toEqual(migrated);
  } finally {
    db.close();
  }
});

it('补齐旧演示项目的摘要，反复打开时保留以前的编辑', async () => {
  const indexedDB = new IDBFactory();
  const previous = {
    id: demoId, name: '已编辑的演示项目', createdAt: 12, updatedAt: 23,
    dataFolder: 'web-demo', nodes: [{ id: 'edited-node' }], edges: [],
  };
  const db = await openTrialDatabase(indexedDB, previous);
  try {
    const trial = startTrialScript(indexedDB);
    await trial.open();
    const firstOpen = await readTrialData(db);
    expect(firstOpen.project).toEqual(previous);
    expect(firstOpen.summary).toMatchObject({ id: demoId, name: previous.name, updatedAt: previous.updatedAt });
    trial.close();
    await trial.open();
    expect(await readTrialData(db)).toEqual(firstOpen);
    expect(trial.opened).toEqual([`app/?demoProject=${demoId}`, `app/?demoProject=${demoId}`]);
  } finally {
    db.close();
  }
});
