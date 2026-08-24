# 用户插件平台与节点工具 MVP

## 目标

允许用户编写本地 JavaScript 插件，并为不同节点类型贡献右键工具和节点工具栏操作。插件只能接收 manifest 明确声明的节点字段与宿主弹窗参数，返回结构化节点数据；宿主校验结果后再通过 Store Action 写回画布。

本阶段不开放主窗口 DOM、Zustand Store、Tauri IPC、Shell、任意文件、任意网络或凭据访问。

## 插件包

首版以文件夹导入，不引入压缩包依赖：

```text
example-plugin/
├── manifest.json
└── main.js
```

`manifest.json` 示例：

```json
{
  "apiVersion": 1,
  "id": "com.example.text-tools",
  "name": "文本节点工具",
  "version": "1.0.0",
  "author": "示例作者",
  "description": "为文本节点提供内容转换工具",
  "category": "content",
  "keywords": ["文本", "转换"],
  "entry": "main.js",
  "permissions": ["node.read", "node.write"],
  "contributes": {
    "nodeTools": [
      {
        "id": "uppercase-output",
        "title": "输出转大写",
        "placements": ["node-context-menu", "node-toolbar"],
        "icon": "lucide:case-upper",
        "dialog": {
          "title": "输出转大写",
          "submitLabel": "转换",
          "fields": [
            { "id": "prefix", "label": "结果前缀", "type": "text" }
          ]
        },
        "nodeTypes": ["ai-text", "source-text"],
        "inputFields": ["label", "prompt", "output"],
        "output": {
          "mode": "update-current",
          "fields": ["output"]
        }
      }
    ]
  }
}
```

`main.js` 使用同步 `definePlugin` 协议：

```js
definePlugin({
  tools: {
    "uppercase-output": (input) => ({
      data: {
        output: String(input.parameters.prefix || "")
          + String(input.node.data.output || "").toUpperCase()
      },
      message: "已转换输出"
    })
  }
});
```

## 执行边界

1. 前端导入文件夹，校验 manifest、入口文件、大小、ID、节点类型、权限和字段声明。
2. 插件源码与 manifest 独立保存在 IndexedDB，不进入项目数据或聊天消息。
3. 用户在节点右键菜单选择插件工具时直接执行；点击节点工具栏插件按钮时，宿主先按 `dialog` 渲染操作弹窗。
4. 宿主按 `inputFields` 构造不可变节点快照，并将经过校验的弹窗值放入 `input.parameters`；本地路径、身份字段和过大值不会进入插件。
5. Rust 为每次调用创建独立 QuickJS Runtime，不安装模块加载器或任何宿主函数；设置内存、栈和执行时间上限。
6. Rust 只接受可 JSON 序列化的同步返回值。
7. 前端复核插件仍启用、项目未切换、canvas revision 未变化，并按 `output.fields` 校验返回字段。
8. `update-current` 通过 `updateNodeData()` 一次性提交历史；`create-node` 通过 `addNode()` 在源节点右侧创建结果节点。

## AI Canvas Plugin Manifest Standard v1

- 身份：`id`、`name`、`version`、`author`。
- 用途：`description`、`category`、`keywords`，安装页据此说明插件是内容、媒体、工作流还是通用工具。
- 兼容：`apiVersion` 是宿主契约版本；未知版本直接拒绝安装。
- 权限：`permissions` 声明可读、可写能力；源码不能扩大权限。
- 贡献点：`contributes.nodeTools` 声明工具及其 `placements`；v1 支持 `node-context-menu` 与 `node-toolbar`。
- 工具栏 UI：`node-toolbar` 必须声明安全的 Iconify `icon` 与宿主 `dialog`；弹窗支持文本、长文本、数字、下拉框和复选框，不允许插件注入 DOM、HTML 或 React 组件。
- 作用域：每个工具以 `nodeTypes` 精确声明出现在哪类节点，以 `inputFields` / `output.fields` 声明会读取和修改什么。

## MVP 边界

- 支持：安装、替换、启用、禁用、卸载；按节点类型显示右键工具和工具栏按钮；声明式操作弹窗；结构化输入/输出；更新当前节点；创建结果节点；超时与内存隔离。
- 暂不支持：插件市场、签名、自动更新、压缩包、异步 JS、第三方模块、网络、文件 grant、自定义 React 节点、任意插件 UI/HTML 面板、Agent 工具注册。
- 后续扩展必须继续走 capability API，不得把 Store、Tauri API 或密钥直接交给插件。

## Plugin API v2 扩展（已实施）

- `contributes.nodes` 可声明宿主渲染的自定义节点、字段及输入输出端口；画布统一使用 `plugin-node` 渲染器，不加载插件 React/HTML。
- 自定义节点继续复用同步 QuickJS 函数，通过最多 4 次受控 effect 请求异步宿主能力。
- `models.read` 只提供脱敏模型目录，`models.invoke` 由现有文本、图片、视频和音频生成服务代为调用，插件拿不到密钥或连接地址。
- `files.read` 只读取用户通过系统选择器授权的 UTF-8 文本，绝对路径仅存在内存；`files.write` 每次通过系统保存弹窗写出文本。
- API v1 插件保持兼容；插件停用或卸载后自定义节点保留为不可用占位，不删除项目数据。

## 回滚

插件记录使用独立 object store。关闭插件入口或降级应用时，旧版本只会忽略该 store，不影响项目画布；禁用插件即可停止其所有节点工具。
