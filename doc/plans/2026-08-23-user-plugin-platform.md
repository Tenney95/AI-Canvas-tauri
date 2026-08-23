# 用户插件平台与节点工具 MVP

## 目标

允许用户编写本地 JavaScript 插件，并为不同节点类型贡献工具。插件只能接收 manifest 明确声明的节点字段，返回结构化节点数据；宿主校验结果后再通过 Store Action 写回画布。

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
        "placements": ["node-context-menu"],
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
      data: { output: String(input.node.data.output || "").toUpperCase() },
      message: "已转换输出"
    })
  }
});
```

## 执行边界

1. 前端导入文件夹，校验 manifest、入口文件、大小、ID、节点类型、权限和字段声明。
2. 插件源码与 manifest 独立保存在 IndexedDB，不进入项目数据或聊天消息。
3. 用户在节点右键菜单选择插件工具。
4. 宿主按 `inputFields` 构造不可变输入快照，剔除本地路径、身份字段和过大值。
5. Rust 为每次调用创建独立 QuickJS Runtime，不安装模块加载器或任何宿主函数；设置内存、栈和执行时间上限。
6. Rust 只接受可 JSON 序列化的同步返回值。
7. 前端复核插件仍启用、项目未切换、canvas revision 未变化，并按 `output.fields` 校验返回字段。
8. `update-current` 通过 `updateNodeData()` 一次性提交历史；`create-node` 通过 `addNode()` 在源节点右侧创建结果节点。

## AI Canvas Plugin Manifest Standard v1

- 身份：`id`、`name`、`version`、`author`。
- 用途：`description`、`category`、`keywords`，安装页据此说明插件是内容、媒体、工作流还是通用工具。
- 兼容：`apiVersion` 是宿主契约版本；未知版本直接拒绝安装。
- 权限：`permissions` 声明可读、可写能力；源码不能扩大权限。
- 贡献点：`contributes.nodeTools` 声明工具及其 `placements`，v1 只允许 `node-context-menu`。
- 作用域：每个工具以 `nodeTypes` 精确声明出现在哪类节点，以 `inputFields` / `output.fields` 声明会读取和修改什么。

## MVP 边界

- 支持：安装、替换、启用、禁用、卸载；按节点类型显示工具；结构化输入/输出；更新当前节点；创建结果节点；超时与内存隔离。
- 暂不支持：插件市场、签名、自动更新、压缩包、异步 JS、第三方模块、网络、文件 grant、自定义 React 节点、任意 UI 面板、Agent 工具注册。
- 后续扩展必须继续走 capability API，不得把 Store、Tauri API 或密钥直接交给插件。

## 回滚

插件记录使用独立 object store。关闭插件入口或降级应用时，旧版本只会忽略该 store，不影响项目画布；禁用插件即可停止其所有节点工具。
