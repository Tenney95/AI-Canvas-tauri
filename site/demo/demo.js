/**
 * 浏览器试用：把真实的 Web 构建加载进首屏画框，并预置一份演示画布。
 *
 * 先让应用建好 IndexedDB，再写入演示项目和列表摘要。应用内已有的演示画布保留。
 */
(function () {
  'use strict';

  var DB_NAME = 'ai-canvas-db';
  var PROJECT_ID = 'aicanvas-web-demo';
  var APP_URL = 'app/';
  var DEMO_URL = APP_URL + '?demoProject=' + PROJECT_ID;

  var shot = document.getElementById('shot');
  if (!shot) return;

  var stage = shot.querySelector('.shot-stage');
  var tryBtn = document.getElementById('tryBtn');
  var loading = shot.querySelector('.try-loading');
  var loadingText = shot.querySelector('.try-loading-text');
  var note = document.getElementById('demoNote');
  var exitBtn = document.getElementById('demoExit');
  var frame = null;
  var started = false;

  function setStatus(text) {
    if (loadingText) loadingText.textContent = text;
  }

  /** 不指定版本打开：库存在则用当前版本，不存在会建一个空库（应用随后自行升级补齐） */
  function openCurrent() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('IndexedDB blocked')); };
    });
  }

  /** 应用是否已经把需要的 store 建出来了 */
  function hasStores() {
    return openCurrent().then(function (db) {
      var ok = db.objectStoreNames.contains('projects')
        && db.objectStoreNames.contains('projectSummaries');
      // 必须立刻关闭：留着连接会挡住应用后续的版本升级
      db.close();
      return ok;
    }).catch(function () { return false; });
  }

  function resolveDemoImages(nodes, fixtureNodes, previous) {
    if (!Array.isArray(nodes)) return nodes;
    var base = new URL(APP_URL, document.baseURI);
    var sources = new Map();
    fixtureNodes.forEach(function (node) {
      var path = node?.data?.imageUrl;
      if (typeof path !== 'string' || !/^\.\.\/demo\/[\w-]+\.(?:png|jpe?g|webp)$/i.test(path)) return;
      sources.set(node.id, {
        from: previous ? path.replace(/\.[a-z]+$/i, '.svg') : path,
        to: new URL(path, base).href,
      });
    });
    var changed = false;
    var resolved = nodes.map(function (node) {
      var source = sources.get(node?.id);
      if (!source || node?.data?.imageUrl !== source.from) return node;
      changed = true;
      return { ...node, data: { ...node.data, imageUrl: source.to } };
    });
    return changed ? resolved : nodes;
  }

  function writeDemo(payload) {
    var fixtureNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    return openCurrent().then(function (db) {
      var tx;
      try {
        tx = db.transaction(['projects', 'projectSummaries'], 'readwrite');
      } catch (error) {
        db.close();
        throw error;
      }
      return new Promise(function (resolve, reject) {
        var projects = tx.objectStore('projects');
        var summaries = tx.objectStore('projectSummaries');
        var projectRequest = projects.get(PROJECT_ID);
        projectRequest.onsuccess = function () {
          var project = projectRequest.result;
          if (!project) {
            var now = Date.now();
            project = {
              id: PROJECT_ID,
              name: payload.name || '演示项目',
              createdAt: now,
              updatedAt: now,
              dataFolder: 'web-demo',
              nodes: resolveDemoImages(fixtureNodes, fixtureNodes, false),
              edges: payload.edges || [],
            };
            projects.add(project);
          } else {
            // 只迁移仍使用原始占位图的演示节点，保留用户替换的图片与其它编辑。
            var nodes = resolveDemoImages(project.nodes, fixtureNodes, true);
            if (nodes !== project.nodes) projects.put({ ...project, nodes: nodes });
          }
          var summaryRequest = summaries.get(PROJECT_ID);
          summaryRequest.onsuccess = function () {
            if (projectRequest.result && summaryRequest.result) return;
            summaries.put({
              id: project.id,
              name: project.name,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              dataFolder: project.dataFolder,
            });
          };
        };
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onabort = function () { db.close(); reject(tx.error); };
      });
    });
  }

  /**
   * 每次都换一个新的 iframe 元素。
   * 复用同一个元素重新赋同样的 src 不保证再次触发 load 事件，会把界面卡在加载态。
   */
  function loadFrame(url) {
    return new Promise(function (resolve) {
      var next = document.createElement('iframe');
      next.className = 'demo-frame';
      next.title = 'AI Canvas 浏览器演示';

      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        if (frame && frame !== next) frame.remove();
        frame = next;
        resolve();
      };
      next.addEventListener('load', finish, { once: true });
      // 应用初始化失败时不要把界面永久卡在加载态
      setTimeout(finish, 20000);
      next.src = url;
      stage.appendChild(next);
    });
  }

  function waitFor(check, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    return new Promise(function (resolve) {
      (function poll() {
        check().then(function (ok) {
          if (ok) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(poll, 300);
        });
      })();
    });
  }

  function start() {
    if (started) return;
    started = true;

    shot.classList.add('is-demo');
    if (loading) loading.hidden = false;
    if (tryBtn) tryBtn.hidden = true;
    setStatus('正在加载应用…');

    var payloadPromise = fetch('demo/canvas.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });

    Promise.all([payloadPromise, hasStores()])
      .then(function (results) {
        var payload = results[0];
        var ready = results[1];
        if (!payload) return loadFrame(APP_URL);

        // 库还没建好时先由应用创建所需的表。
        var prepared = ready
          ? Promise.resolve(true)
          : loadFrame(APP_URL).then(function () {
              setStatus('正在准备演示画布…');
              return waitFor(hasStores, 15000);
            });

        return prepared.then(function (ok) {
          if (!ok) return loadFrame(APP_URL);
          return writeDemo(payload)
            .then(function () {
              setStatus('正在打开演示画布…');
              return loadFrame(DEMO_URL);
            }, function () {
              return loadFrame(APP_URL);
            });
        });
      })
      .then(function () {
        if (loading) loading.hidden = true;
        if (note) note.hidden = false;
        if (exitBtn) exitBtn.hidden = false;
        shot.classList.add('is-live');
      })
      .catch(function () {
        if (loading) loading.hidden = true;
        if (tryBtn) tryBtn.hidden = false;
        shot.classList.remove('is-demo');
        started = false;
      });
  }

  function stop() {
    stage.querySelectorAll('.demo-frame').forEach(function (el) { el.remove(); });
    frame = null;
    started = false;
    shot.classList.remove('is-demo', 'is-live');
    if (loading) loading.hidden = true;
    if (note) note.hidden = true;
    if (exitBtn) exitBtn.hidden = true;
    if (tryBtn) tryBtn.hidden = false;
  }

  if (tryBtn) tryBtn.addEventListener('click', start);
  if (exitBtn) exitBtn.addEventListener('click', stop);
})();
