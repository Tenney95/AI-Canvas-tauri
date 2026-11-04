# MCP 可靠性修复实施计划

目标：修复 2026-11-04 静态审查确认的六项缺口，每项独立提交。任务类型为明确缺陷修复，不改变工具权限矩阵。

复用现有截图敏感标记、AgentTask 取消、瞬时 MCP 内容、原生限额与 SDK 握手；不新增依赖，不修改 Tauri 安全配置。模块入口为 [MCP 控制](../MCP控制模块.md)。用户已授权全部六项及逐项提交；本轮不运行测试、类型检查、lint、构建或桌面验收。

## 阶段与文件

| 项目 | 主要文件（测试不计入源码范围） | 状态 |
| --- | --- | --- |
| 1. 配置截图脱敏 | `components/settings/McpControlSettings.tsx`、本计划、模块入口；`tests/components/mcpControlSettings.test.ts` | 已实现，待用户验收 |
| 2. 请求生命周期取消 | `src-tauri/src/mcp/bridge.rs`、`services/mcp/mcpControlService.ts`、`scripts/ai-canvas-mcp.mjs`、本计划；对应原生与控制层/适配器测试 | 待实施 |
| 3. 完整业务结果 | `services/chat/agentRoundExecutor.ts`、`services/mcp/mcpControlService.ts`（按需）、本计划；对应执行器与 MCP 结果测试 | 待实施 |
| 4. stdio 在途限额 | `src-tauri/src/mcp/bridge.rs`、本计划；原生内置测试 | 待实施 |
| 5. 外部连接保存串行化 | `services/mcp/mcpClientService.ts`、本计划；`tests/services/mcpClientService.test.ts` | 待实施 |
| 6. 外部会话失效恢复 | `services/mcp/mcpClientService.ts`、本计划；`tests/services/mcpClientService.test.ts` | 待实施 |

前端相对路径均以 `src/` 为根。每阶段提交前静态核对差异、调用引用、严格 UTF-8 和差异空白；这些核对不代表功能测试通过。

## 用户桌面验收

前置：使用包含本轮修改的 Tauri 桌面端；涉及 Rust 的阶段须重新编译并重启，准备可信 MCP 客户端和外部测试服务，不用付费生成验证取消。

1. 开启 MCP，在设置页显示客户端配置；分别用默认脱敏窗口截图和截图入画布，配置区域应被排除。手动复制应仍得到完整配置。回归 stdio/HTTP、深浅主题。
2. 发起等待用户选择或可取消的慢操作，再停止 MCP、轮换令牌、断开 stdio 或等待超时；旧任务应终止，随后选择或迟到结果不得继续执行。回归首次调用立即取消及 HTTP 主动取消；已提交的外部副作用不能承诺撤回，失败不得自动重投。
3. 查询带长提示词的多个节点，使完整结果超过 20,000 字符；预算内必须是可解析的完整 JSON，超过 MCP 预算须明确反馈。回归目录 schema、图片/媒体内容及普通助手的模型文本预算。
4. 同连接连续提交慢请求直至上限，应立即返回忙碌且仍能取消；结束后名额恢复，不影响其他连接。重复 ID 不得破坏原请求。
5. 保存外部连接期间关闭编辑器，重新打开并保存/移除同一连接；过期操作不能替换当前连接的凭据或覆盖新修订。凭据和配置保存失败须能安全重试。
6. 建立外部连接后重启服务或让会话过期；下一次发现应重新握手恢复。写请求遇到失效会话不得自动重投；回归认证失败、普通 404、停用连接和取消。

供用户执行的命令：在仓库根目录运行 `npx vitest run tests/components/mcpControlSettings.test.ts tests/services/mcp/mcpControlService.test.ts tests/services/mcpClientService.test.ts`，适配器用 `node --test tests/scripts/aiCanvasMcp.test.mjs`；在 `src-tauri/` 运行 `cargo test mcp_bridge::tests --lib` 和 `cargo check --lib`。本轮均未运行。

## 回退

按独立提交逐项回退；不回滚项目数据、凭据数据库或既有权限配置。关闭 MCP、停用外部连接可停止新增调用；已提交远端操作需核实实际状态。
