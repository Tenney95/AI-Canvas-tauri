//! 用户插件运行时。
//!
//! 每次调用创建独立 Runtime，不安装模块、文件、网络或 Tauri 宿主函数；
//! JavaScript 继续使用 QuickJS 强沙箱。Python 插件是用户显式信任的本机代码，
//! 通过一次性子进程执行；这里只提供协议、超时和输出上限，不宣称操作系统隔离。

use rquickjs::{Context, Runtime};
use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Webview;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const MAX_SOURCE_BYTES: usize = 512 * 1024;
const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MEMORY_LIMIT_BYTES: usize = 64 * 1024 * 1024;
const MAX_STACK_BYTES: usize = 512 * 1024;
const JAVASCRIPT_EXECUTION_TIMEOUT: Duration = Duration::from_secs(2);
const PYTHON_EXECUTION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ERROR_BYTES: usize = 64 * 1024;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const PYTHON_RUNNER: &str = r#"
import contextlib
import inspect
import json
import sys

class _DiscardOutput:
    def write(self, value):
        return len(value)

    def flush(self):
        return None

def _run():
    payload = json.load(sys.stdin)
    definition = None

    def define_plugin(value):
        nonlocal definition
        if definition is not None:
            raise RuntimeError("define_plugin 只能调用一次")
        definition = value

    namespace = {"__name__": "__ai_canvas_plugin__", "define_plugin": define_plugin}
    discarded = _DiscardOutput()
    with contextlib.redirect_stdout(discarded), contextlib.redirect_stderr(discarded):
        exec(compile(payload["source"], "<ai-canvas-plugin>", "exec"), namespace, namespace)
        if not isinstance(definition, dict):
            raise RuntimeError("插件必须调用 define_plugin")
        tools = definition.get("tools")
        tool = tools.get(payload["toolId"]) if isinstance(tools, dict) else None
        if not callable(tool):
            raise RuntimeError("插件未注册该节点工具")
        result = tool(payload["input"])
        if inspect.isawaitable(result):
            raise RuntimeError("Python 插件工具不支持异步返回值")
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))

try:
    _run()
except BaseException as error:
    message = str(error).replace("\r", " ").replace("\n", " ")[:4096]
    sys.stderr.write(f"{type(error).__name__}: {message}")
    raise SystemExit(1)
"#;

#[derive(Clone, Debug)]
struct PythonCommand {
    program: String,
    prefix_args: Vec<String>,
    label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonPluginRuntimeStatus {
    available: bool,
    command: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

#[cfg(windows)]
fn configure_background_process(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_background_process(_command: &mut Command) {}

fn python_candidates() -> Vec<PythonCommand> {
    #[cfg(windows)]
    let candidates = vec![
        ("python", vec![], "python"),
        ("py", vec!["-3"], "py -3"),
        ("python3", vec![], "python3"),
    ];
    #[cfg(not(windows))]
    let candidates = vec![("python3", vec![], "python3"), ("python", vec![], "python")];

    candidates
        .into_iter()
        .map(|(program, args, label)| PythonCommand {
            program: program.to_string(),
            prefix_args: args.into_iter().map(str::to_string).collect(),
            label: label.to_string(),
        })
        .collect()
}

fn probe_python(candidate: &PythonCommand) -> Option<String> {
    let mut command = Command::new(&candidate.program);
    command.args(&candidate.prefix_args).args([
        "-c",
        "import sys; print('.'.join(map(str, sys.version_info[:3])))",
    ]);
    configure_background_process(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

fn find_python() -> Result<(PythonCommand, String), String> {
    for candidate in python_candidates() {
        if let Some(version) = probe_python(&candidate) {
            return Ok((candidate, version));
        }
    }
    Err(
        "未找到可用的 Python 3。请安装 Python，并确保 python、python3 或 Windows py -3 可用"
            .to_string(),
    )
}

fn read_limited<R: Read>(mut reader: R, limit: usize) -> Result<(Vec<u8>, bool), String> {
    let mut stored = Vec::with_capacity(limit.min(8192));
    let mut exceeded = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取插件子进程输出失败: {error}"))?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(stored.len());
        if remaining > 0 {
            stored.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        if count > remaining {
            exceeded = true;
        }
    }
    Ok((stored, exceeded))
}

fn execute_python_with_command(
    python: &PythonCommand,
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
    let envelope = serde_json::json!({ "source": source, "toolId": tool_id, "input": input });
    let input_json = serde_json::to_vec(&envelope)
        .map_err(|error| format!("Python 插件输入序列化失败: {error}"))?;
    if input_json.len() > MAX_INPUT_BYTES + MAX_SOURCE_BYTES {
        return Err("Python 插件输入超过上限".to_string());
    }

    let mut command = Command::new(&python.program);
    command
        .args(&python.prefix_args)
        .args(["-u", "-c", PYTHON_RUNNER])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .env_remove("AI_CANVAS_PLUGIN_INPUT")
        .env_remove("AI_CANVAS_PLUGIN_OUTPUT");
    configure_background_process(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 Python 插件进程失败: {error}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法打开 Python 插件输入".to_string())?;
    stdin
        .write_all(&input_json)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("写入 Python 插件输入失败: {error}"))?;
    drop(stdin);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 Python 插件输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 Python 插件错误".to_string())?;
    let stdout_reader = thread::spawn(move || read_limited(stdout, MAX_OUTPUT_BYTES));
    let stderr_reader = thread::spawn(move || read_limited(stderr, MAX_ERROR_BYTES));

    let deadline = Instant::now() + timeout;
    let exit_status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("等待 Python 插件进程失败: {error}"))?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(format!(
                "Python 插件执行超过 {} 秒，已终止",
                timeout.as_secs()
            ));
        }
        thread::sleep(Duration::from_millis(10));
    };

    let (stdout, stdout_exceeded) = stdout_reader
        .join()
        .map_err(|_| "Python 插件输出读取线程异常".to_string())??;
    let (stderr, stderr_exceeded) = stderr_reader
        .join()
        .map_err(|_| "Python 插件错误读取线程异常".to_string())??;
    if stdout_exceeded {
        return Err("Python 插件输出超过 1 MiB 上限".to_string());
    }
    if !exit_status.success() {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        let suffix = if stderr_exceeded {
            "（错误信息已截断）"
        } else {
            ""
        };
        return Err(if detail.is_empty() {
            format!("Python 插件执行失败{suffix}")
        } else {
            format!("Python 插件执行失败: {detail}{suffix}")
        });
    }
    serde_json::from_slice(&stdout)
        .map_err(|error| format!("Python 插件输出不是有效 JSON: {error}"))
}

fn execute_python(
    source: String,
    tool_id: String,
    input: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let (python, _) = find_python()?;
    execute_python_with_command(&python, source, tool_id, input, timeout)
}

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

fn execute_plugin_tool_inner(
    runtime: String,
    source: String,
    tool_id: String,
    input: Value,
) -> Result<Value, String> {
    match runtime.as_str() {
        "javascript" => execute_with_timeout(source, tool_id, input, JAVASCRIPT_EXECUTION_TIMEOUT),
        "python" => execute_python(source, tool_id, input, PYTHON_EXECUTION_TIMEOUT),
        _ => Err("不支持的插件运行时".to_string()),
    }
}

#[tauri::command]
pub async fn execute_node_plugin_tool(
    webview: Webview,
    runtime: String,
    source: String,
    tool_id: String,
    input: Value,
) -> Result<Value, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        execute_plugin_tool_inner(runtime, source, tool_id, input)
    })
    .await
    .map_err(|error| format!("插件运行任务失败: {error}"))?
}

#[tauri::command]
pub async fn get_python_plugin_runtime_status(
    webview: Webview,
) -> Result<PythonPluginRuntimeStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let status = tauri::async_runtime::spawn_blocking(|| match find_python() {
        Ok((python, version)) => PythonPluginRuntimeStatus {
            available: true,
            command: Some(python.label),
            version: Some(version),
            error: None,
        },
        Err(error) => PythonPluginRuntimeStatus {
            available: false,
            command: None,
            version: None,
            error: Some(error),
        },
    })
    .await
    .unwrap_or_else(|error| PythonPluginRuntimeStatus {
        available: false,
        command: None,
        version: None,
        error: Some(format!("Python 环境检测失败: {error}")),
    });
    Ok(status)
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

    #[test]
    fn executes_python_plugin_when_python_is_available() {
        let Ok((python, _)) = find_python() else {
            return;
        };
        let result = execute_python_with_command(
            &python,
            r#"
def upper(input_value):
    return {"data": {"output": input_value["node"]["data"]["output"].upper()}}

define_plugin({"tools": {"upper": upper}})
"#
            .to_string(),
            "upper".to_string(),
            json!({ "node": { "data": { "output": "hello" } } }),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(result["data"]["output"], "HELLO");
    }

    #[test]
    fn terminates_python_plugin_after_timeout_when_python_is_available() {
        let Ok((python, _)) = find_python() else {
            return;
        };
        let error = execute_python_with_command(
            &python,
            r#"
def loop(_input_value):
    while True:
        pass

define_plugin({"tools": {"loop": loop}})
"#
            .to_string(),
            "loop".to_string(),
            json!({}),
            Duration::from_millis(100),
        )
        .unwrap_err();
        assert!(error.contains("已终止"));
    }

    #[test]
    fn rejects_unknown_runtime() {
        let error = execute_plugin_tool_inner(
            "ruby".to_string(),
            "puts 1".to_string(),
            "tool".to_string(),
            json!({}),
        )
        .unwrap_err();
        assert!(error.contains("不支持的插件运行时"));
    }
}
