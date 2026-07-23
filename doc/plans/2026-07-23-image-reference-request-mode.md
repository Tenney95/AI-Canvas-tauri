# 通用图片模型参考图请求方式设计

## 背景

同一个图片模型在不同中转服务上可能使用不同的参考图协议。APIMart 的 `gpt-image-2` 通过 `/images/generations` 接收 JSON `image_urls`，RealmRouter 则要求有原图时调用 `/images/edits` 并使用 `multipart/form-data` 上传文件。请求方式不能由模型 ID 推断，也不能把厂商域名硬编码到图片节点或通用适配器中。

## 设计

在自定义连接的图片模型元数据中增加可选的 `imageReferenceRequestMode`：

- `generation-json-image-urls`：保持现有 `/images/generations` JSON 请求，并将参考图写入 `image_urls`。这是缺省值，保证旧配置和 APIMart 类兼容接口行为不变。
- `edits-multipart`：无参考图时仍使用 `/images/generations` JSON；存在参考图时改用 `/images/edits`，把远程参考图读取为文件并上传到 multipart 的 `image[]` 字段。

该字段随 `ProviderModelSelection` 保存，并同步到 `GeneralModelConfig`。设置入口复用现有模型协议面板，不新增 Provider 特例。通用图片生成入口仅把显式配置传给标准图片适配器；内置 APIMart、火山方舟、RunningHub 和工作流适配器保持原调用链。

Tauri 环境继续复用受限的 `proxy_stream_fetch`。共享 HTTP 传输层负责把浏览器 `FormData` 序列化为带 boundary 的字节请求，Rust 端只透传既有同源调用产生的请求体，不修改 Tauri 安全配置。

## 验证

测试分别覆盖：缺省 JSON 文生图、JSON 参考图、multipart 单/多参考图、Tauri FormData 字节与 Content-Type、模型配置同步和旧配置缺省兼容。最后运行前端与测试类型检查、定向 ESLint、生产构建、差异检查和严格 UTF-8 扫描。
