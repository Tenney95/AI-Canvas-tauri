# AI Canvas 官网

线上地址：<https://tenney95.github.io/AI-Canvas-tauri/>

`site/` 是 AI Canvas 的产品官网，纯静态页面，不参与主应用构建，也不引入任何构建步骤或外部 CDN 资源。

```text
site/
├── index.html      # 产品首页
├── manual.html     # 中文操作说明书（独立 HTML，内嵌样式、脚本与截图）
├── styles.css      # 全部样式（深色单主题）
├── script.js       # 滚动进场、平台识别、导航交互
├── .nojekyll       # 跳过 GitHub Pages 的 Jekyll 处理
├── assets/
│   ├── icon.svg        # 复制自 public/icons.svg
│   ├── favicon.svg     # 复制自 public/favicon.svg
│   └── screenshot.png  # 复制自 public/screenshot.png
├── demo/
│   ├── demo.js               # 浏览器试用：加载应用 + 播种演示画布
│   ├── canvas.json           # 演示画布的 nodes / edges
│   ├── make-placeholders.mjs # 生成占位素材
│   └── *.svg                 # 占位素材
└── app/            # Web 构建产物，由 workflow 生成，已 gitignore
```

## 操作说明书

[manual.html](./manual.html) 可直接离线打开，也可在本地服务的 `/manual.html` 访问；通过应用开发服务预览时路径为 `/site/manual.html`。它不依赖 `site/app/` 构建，支持章节搜索、锚点导航、复制示例、图片放大、明暗主题与打印。

当前文档基线为 0.9.7，功能核对日期为 2026-09-11；后续源码功能与已发布安装包的差异在说明书末尾注明。自定义接口部分保留完整配置流程，工作流 API 另列能力 JSON、协议 JSON 与恢复步骤。

维护时同步目录和锚点，使用占位凭据；已有 8 张截图以内嵌 Data URL 保存。更换或压缩截图应验证像素与尺寸，纯文案更新需保证图片数据完全不变。文档导航见[模块入口](../doc/文档导航.md)。

## 浏览器试用是怎么工作的

首屏画框默认是静态截图，点击「在浏览器里试用」后才加载 `site/app/`（应用的真实 Web 构建）。

演示数据**不复制**应用的 IndexedDB schema——那样每次 schema 升级都会失配。实际顺序是：

1. 先把应用加载一次，让它自己建库并完成首启初始化（含写入自己的默认项目和 `last-active-project`）；
2. 等它落定后，再往 `projects` / `metadata` 两个 store 写演示项目，并把 `last-active-project` 指向它；
3. 换一个新的 iframe 元素重新加载，应用就会打开演示画布。

拿不到 store 或写入失败时会安静退化成空画布，不会卡在加载态。第二步之所以要等，是因为应用首启会覆盖 `last-active-project`；第三步之所以换新元素，是因为对同一个 iframe 重设相同 `src` 不保证再次触发 `load`。

### 换成真实素材

把 `site/demo/` 下的占位 SVG 换成真实图片，再同步改 `canvas.json` 里对应节点的 `imageUrl` 即可，不用改代码。`imageUrl` 是相对 `site/app/` 解析的，所以写成 `../demo/xxx.jpg`。

## 本地预览

演示需要先构建一次应用（产物不入库）：

```bash
npx vite build --base=./ --outDir site/app --emptyOutDir
```

再起任意静态服务器：

```bash
python3 -m http.server 4321 --directory site
```

然后访问 <http://localhost:4321>。不构建 `site/app/` 也能预览页面，只是试用按钮点了会退化成空白框。

## 部署

`.github/workflows/pages.yml` 会在 `site/**` 或 `src/**` 变更推送到 `master` 时构建 Web 应用并部署到 GitHub Pages，也可以在 Actions 页面手动触发。

首次部署前需要在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。

## 维护约定

- 页面文案以 `README.md` 与 `.release-notes.md` 的既有描述为准，不要写入未实现的能力。
- 首页 hero、下载区、四种语言 README 和说明书分别核对版本；说明书同时维护核对日期和后续功能范围。`sync-version` 不会自动同步这些全部位置。
- 应用截图更新后，重新从 `public/screenshot.png` 复制到 `site/assets/`。
- 保持零外部依赖：不要引入 CDN 字体、脚本或分析代码。
