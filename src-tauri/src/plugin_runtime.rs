//! 用户插件 QuickJS 沙箱。
//!
//! 每次调用创建独立 Runtime，不安装模块、文件、网络或 Tauri 宿主函数；
//! Renderer 只传入已裁剪的 JSON 节点快照，返回值也必须是有界 JSON。

use rquickjs::{Context, Runtime};
use serde_json::Value;
use std::time::{Duration, Instant};

const MAX_SOURCE_BYTES: usize = 512 * 1024;
const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MEMORY_LIMIT_BYTES: usize = 64 * 1024 * 1024;
const MAX_STACK_BYTES: usize = 512 * 1024;
const EXECUTION_TIMEOUT: Duration = Duration::from_secs(2);

fn execute_with_timeout(
    source: String,
    tool_id: String,
    input: Value,
    timeout: Duration,
) -> Result<Value, String> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err("插件源码超过 512 KiB 上限".to_string());
    }
    if tool_id.is_empty() || tool_id.len() > 64 {
        return Err("插件工具 ID 无效".to_string());
    }
    let input_json =
        serde_json::to_string(&input).map_err(|error| format!("插件输入序列化失败: {error}"))?;
    if input_json.len() > MAX_INPUT_BYTES {
        return Err("插件输入超过 1 MiB 上限".to_string());
    }
    let tool_id_json = serde_json::to_string(&tool_id).map_err(|error| error.to_string())?;

    let runtime = Runtime::new().map_err(|error| format!("创建插件沙箱失败: {error}"))?;
    runtime.set_memory_limit(MEMORY_LIMIT_BYTES);
    runtime.set_max_stack_size(MAX_STACK_BYTES);
    let deadline = Instant::now() + timeout;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context =
        Context::full(&runtime).map_err(|error| format!("创建插件上下文失败: {error}"))?;

    let script = format!(
        r#"
"use strict";
let __pluginDefinition = null;
function definePlugin(definition) {{
  if (__pluginDefinition !== null) throw new Error("definePlugin 只能调用一次");
  __pluginDefinition = definition;
}}
{source}
if (!__pluginDefinition || typeof __pluginDefinition !== "object") {{
  throw new Error("插件必须调用 definePlugin");
}}
const __toolId = {tool_id_json};
const __tool = __pluginDefinition.tools && __pluginDefinition.tools[__toolId];
if (typeof __tool !== "function") throw new Error("插件未注册该节点工具");
const __input = Object.freeze({input_json});
const __result = __tool(__input);
if (__result && typeof __result.then === "function") {{
  throw new Error("首版插件工具不支持异步返回值");
}}
const __json = JSON.stringify(__result);
if (typeof __json !== "string") throw new Error("插件必须返回可 JSON 序列化的对象");
__json;
"#,
    );

    let output_json = context
        .with(|ctx| ctx.eval::<String, _>(script))
        .map_err(|error| {
            if Instant::now() >= deadline {
                "插件执行超过 2 秒，已终止".to_string()
            } else {
                format!("插件执行失败: {error}")
            }
        })?;
    if output_json.len() > MAX_OUTPUT_BYTES {
        return Err("插件输出超过 1 MiB 上限".to_string());
    }
    serde_json::from_str(&output_json).map_err(|error| format!("插件输出不是有效 JSON: {error}"))
}

#[tauri::command]
pub async fn execute_node_plugin_tool(
    source: String,
    tool_id: String,
    input: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        execute_with_timeout(source, tool_id, input, EXECUTION_TIMEOUT)
    })
    .await
    .map_err(|error| format!("插件沙箱任务失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn executes_registered_tool_with_json_input() {
        let result = execute_with_timeout(
            r#"definePlugin({ tools: { upper: (input) => ({ data: { output: input.node.data.output.toUpperCase() } }) } });"#.to_string(),
            "upper".to_string(),
            json!({ "node": { "data": { "output": "hello" } } }),
            Duration::from_millis(200),
        )
        .unwrap();
        assert_eq!(result["data"]["output"], "HELLO");
    }

    #[test]
    fn rejects_unregistered_tool() {
        let error = execute_with_timeout(
            "definePlugin({ tools: {} });".to_string(),
            "missing".to_string(),
            json!({}),
            Duration::from_millis(200),
        )
        .unwrap_err();
        assert!(error.contains("插件执行失败"));
    }

    #[test]
    fn interrupts_infinite_loop() {
        let error = execute_with_timeout(
            "definePlugin({ tools: { loop: () => { while (true) {} } } });".to_string(),
            "loop".to_string(),
            json!({}),
            Duration::from_millis(20),
        )
        .unwrap_err();
        assert!(error.contains("已终止"));
    }
}
