    use super::*;
    use serde_json::json;

    const PROBE_TEST_HELPER_ENV: &str = "AI_CANVAS_PLUGIN_RUNTIME_PROBE_TEST_HELPER";

    fn available_python() -> Result<(PythonCommand, String), String> {
        find_python(Instant::now() + PYTHON_STATUS_PROBE_TIMEOUT, None)
    }

    fn hanging_probe_test_command() -> Command {
        let mut command = Command::new(std::env::current_exe().expect("test executable path"));
        command
            .args([
                "--exact",
                "plugin_runtime::tests::managed_probe_test_helper",
                "--nocapture",
            ])
            .env(PROBE_TEST_HELPER_ENV, "hang");
        command
    }

    #[test]
    fn managed_probe_test_helper() {
        if std::env::var(PROBE_TEST_HELPER_ENV).as_deref() == Ok("hang") {
            thread::sleep(Duration::from_secs(60));
        }
    }

    #[test]
    fn executes_registered_tool_with_json_input() {
        let result = execute_with_timeout(
            r#"definePlugin({ tools: { upper: (input) => ({ data: { output: input.node.data.output.toUpperCase() } }) } });"#.to_string(),
            "upper".to_string(),
            json!({ "node": { "data": { "output": "hello" } } }),
            Duration::from_millis(200),
            None,
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
            None,
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
            None,
        )
        .unwrap_err();
        assert!(error.contains("已终止"));
    }

    #[test]
    fn awaits_async_tools_promise_chains_and_thenables() {
        for tool in [
            r#"async (input) => {
                const parts = await Promise.all([Promise.resolve("异步"), Promise.resolve(input.suffix)]);
                await Promise.resolve();
                return { data: { output: parts.join("") } };
            }"#,
            r#"(input) => Promise.resolve(input.suffix).then(suffix => ({ data: { output: "异步" + suffix } }))"#,
            r#"(input) => ({ then(resolve) { resolve({ data: { output: "异步" + input.suffix } }); } })"#,
        ] {
            let result = execute_with_timeout(
                format!("definePlugin({{ tools: {{ run: {tool} }} }});"),
                "run".into(),
                json!({"suffix": "完成"}),
                Duration::from_millis(200),
                None,
            )
            .unwrap();
            assert_eq!(result["data"]["output"], "异步完成");
        }
    }

    #[test]
    fn async_tools_preserve_effect_reentry_contract() {
        let source = r#"definePlugin({ tools: { run: async (input) => {
            await Promise.resolve();
            if (!input.effectResult) return { effect: { type: "settings.get", key: "preferences" } };
            return { data: { output: input.effectResult.value.value.language } };
        } } });"#;
        let request = execute_with_timeout(
            source.into(),
            "run".into(),
            json!({}),
            Duration::from_millis(200),
            None,
        )
        .unwrap();
        assert_eq!(
            request,
            json!({"effect": {"type": "settings.get", "key": "preferences"}})
        );
        let result = execute_with_timeout(source.into(), "run".into(), json!({
            "effectResult": { "ok": true, "value": { "found": true, "value": { "language": "zh-CN" } } }
        }), Duration::from_millis(200), None).unwrap();
        assert_eq!(result["data"]["output"], "zh-CN");
    }

    #[test]
    fn rejects_unresolved_and_rejected_promises_without_serializing_them_as_empty_objects() {
        for (tool, message) in [
            ("() => new Promise(() => {})", "Promise 未完成"),
            (
                "async () => { await new Promise(() => {}); }",
                "Promise 未完成",
            ),
            ("async () => { throw new Error('failed'); }", "插件执行失败"),
            ("() => Promise.reject('failed')", "插件执行失败"),
            ("async () => undefined", "插件执行失败"),
            (
                "async () => { const value = {}; value.child = value; return value; }",
                "插件执行失败",
            ),
        ] {
            let error = execute_with_timeout(
                format!("definePlugin({{ tools: {{ run: {tool} }} }});"),
                "run".into(),
                json!({}),
                Duration::from_millis(200),
                None,
            )
            .unwrap_err();
            assert!(error.contains(message), "{error}");
        }
    }

    #[test]
    fn bounds_async_output_and_microtask_loops_with_the_same_deadline() {
        let error = execute_with_timeout(
            "definePlugin({ tools: { run: async () => ({ data: { output: 'a'.repeat(1024 * 1024) } }) } });".into(),
            "run".into(), json!({}), Duration::from_millis(500), None,
        ).unwrap_err();
        assert!(error.contains("输出超过"));
        for tool in [
            "async () => { while (true) await Promise.resolve(); }",
            "async () => { await Promise.resolve(); while (true) {} }",
            "() => ({ then(resolve) { resolve(this); } })",
        ] {
            let error = execute_with_timeout(
                format!("definePlugin({{ tools: {{ run: {tool} }} }});"),
                "run".into(),
                json!({}),
                Duration::from_millis(20),
                None,
            )
            .unwrap_err();
            assert!(error.contains("已终止"), "{error}");
        }
    }

    #[test]
    fn cancels_running_javascript_and_releases_its_invocation_guard() {
        let active = ActivePluginInvocation::register("plugin-js-cancel", "js-loop").unwrap();
        let cancellation_request = Arc::clone(&active.cancelled);
        let request_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(10));
            cancellation_request.store(true, Ordering::Release);
        });
        let error = execute_with_timeout(
            "definePlugin({ tools: { run: async () => { while (true) await Promise.resolve(); } } });".into(),
            "run".into(), json!({}), Duration::from_secs(2), Some(Arc::clone(&active.cancelled)),
        ).unwrap_err();
        request_thread.join().unwrap();
        assert!(error.contains("已取消"), "{error}");
        drop(active);
        let fresh = ActivePluginInvocation::register("plugin-js-cancel", "js-loop").unwrap();
        assert!(!fresh.cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn single_invocation_cancellation_handles_both_arrival_orders_and_plugin_scope() {
        cancel_invocation("early-js-cancel", "pending-1").unwrap();
        let error = ActivePluginInvocation::register("early-js-cancel", "pending-1")
            .err()
            .unwrap();
        assert!(error.contains("已取消"));
        let active = ActivePluginInvocation::register("scoped-cancel-a", "pending-2").unwrap();
        let other = ActivePluginInvocation::register("scoped-cancel-b", "pending-2").unwrap();
        cancel_invocation("scoped-cancel-a", "pending-2").unwrap();
        assert!(active.cancelled.load(Ordering::Acquire));
        assert!(!other.cancelled.load(Ordering::Acquire));
        assert!(cancel_invocation("../invalid", "pending-2").is_err());
        drop(active);
        let fresh = ActivePluginInvocation::register("scoped-cancel-a", "pending-2").unwrap();
        assert!(!fresh.cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn javascript_diagnostics_preserve_source_lines_and_hide_common_sensitive_details() {
        for (source, expected) in [
            ("definePlugin({ tools: { run: async () => {\nthrow new Error('转换失败');\n} } });", "main.js:2"),
            ("definePlugin({ tools: { run: () => Promise.reject('拒绝执行') } });", "拒绝执行"),
            ("definePlugin({ tools: { run: () => { throw new Error('api_key=private-value /Users/private/file.txt https://private.example/path'); } } });", "已隐藏"),
        ] {
            let error = execute_with_timeout(source.into(), "run".into(), json!({}), Duration::from_millis(200), None).unwrap_err();
            assert!(error.contains(expected), "{error}");
            assert!(error.contains("run ·"));
            for forbidden in ["private-value", "/Users/private", "https://private.example"] { assert!(!error.contains(forbidden)); }
        }
        let error = execute_with_timeout(
            "definePlugin({ tools: {".into(),
            "run".into(),
            json!({}),
            Duration::from_millis(200),
            None,
        )
        .unwrap_err();
        assert!(error.contains("加载/注册"));
        assert!(error.contains("main.js:1"), "{error}");
    }

    #[test]
    fn executes_python_plugin_when_python_is_available() {
        let Ok((python, _)) = available_python() else {
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
            None,
        )
        .unwrap();
        assert_eq!(result["data"]["output"], "HELLO");
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn returns_after_python_main_exits_while_a_descendant_holds_output_pipes() {
        let Ok((python, _)) = available_python() else {
            return;
        };
        let (sender, receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let result = execute_python_with_command(
                &python,
                r#"
import subprocess
import sys

def spawn_descendant(_input_value):
    subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        stdin=subprocess.DEVNULL,
        stdout=sys.__stdout__,
        stderr=sys.__stderr__,
        close_fds=False,
    )
    return {"data": {"output": "parent-finished"}}

define_plugin({"tools": {"spawn": spawn_descendant}})
"#
                .to_string(),
                "spawn".to_string(),
                json!({}),
                Duration::from_secs(5),
                None,
            );
            let _ = sender.send(result);
        });

        let result = receiver
            .recv_timeout(Duration::from_secs(8))
            .expect("Python 主进程退出后，继承管道的后代不得让调用无限等待")
            .unwrap();
        assert_eq!(result["data"]["output"], "parent-finished");
    }

    #[test]
    fn bounds_a_hanging_probe_without_path_changes() {
        let hard_deadline = Instant::now() + Duration::from_millis(300);
        let started = Instant::now();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut command = hanging_probe_test_command();
            let result = run_python_probe_command(&mut command, hard_deadline, None);
            let _ = sender.send(result);
        });

        let result = receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("Python 探测必须在外层硬上限内返回")
            .unwrap();
        assert!(result.is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn cancels_a_hanging_probe_without_path_changes() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation_request = Arc::clone(&cancelled);
        let request_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            cancellation_request.store(true, Ordering::Release);
        });
        let started = Instant::now();
        let mut command = hanging_probe_test_command();

        let error = run_python_probe_command(
            &mut command,
            Instant::now() + Duration::from_secs(2),
            Some(cancelled.as_ref()),
        )
        .unwrap_err();

        request_thread.join().unwrap();
        assert!(error.contains("环境检测已取消"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn returns_after_the_python_process_closes_stdin_early() {
        let Ok((python, _)) = available_python() else {
            return;
        };
        let mut prefix_args = python.prefix_args;
        prefix_args.extend([
            "-c".to_string(),
            "import sys,time; sys.stdin.close(); time.sleep(60)".to_string(),
        ]);
        let closing_candidate = PythonCommand {
            program: python.program,
            prefix_args,
            label: "stdin-closing test interpreter".to_string(),
        };
        let large_source = "#".repeat(MAX_SOURCE_BYTES);
        let started = Instant::now();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let result = execute_python_with_command(
                &closing_candidate,
                large_source,
                "tool".to_string(),
                json!({}),
                Duration::from_millis(500),
                None,
            );
            let _ = sender.send(result);
        });

        let error = receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("Python 提前关闭 stdin 后，输入写线程不得让调用无限等待")
            .unwrap_err();
        assert!(error.contains("写入 Python 插件输入失败") || error.contains("已终止"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn terminates_python_plugin_after_timeout_when_python_is_available() {
        let Ok((python, _)) = available_python() else {
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
            None,
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
            None,
        )
        .unwrap_err();
        assert!(error.contains("不支持的插件运行时"));
    }

    #[test]
    fn cancels_active_python_plugin_when_python_is_available() {
        let Ok((python, _)) = available_python() else {
            return;
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation_request = Arc::clone(&cancelled);
        let request_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            cancellation_request.store(true, Ordering::Release);
        });
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
            Duration::from_secs(5),
            Some(cancelled.as_ref()),
        )
        .unwrap_err();
        request_thread.join().unwrap();
        assert!(error.contains("已取消"));
    }

    #[test]
    fn cancels_all_registered_invocations_for_one_plugin() {
        let first = ActivePluginInvocation::register("plugin-a", "invocation-1").unwrap();
        let second = ActivePluginInvocation::register("plugin-a", "invocation-2").unwrap();
        let other = ActivePluginInvocation::register("plugin-b", "invocation-1").unwrap();

        cancel_plugin_invocations("plugin-a");

        assert!(first.cancelled.load(Ordering::Acquire));
        assert!(second.cancelled.load(Ordering::Acquire));
        assert!(!other.cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn cancels_every_registered_invocation_during_registry_repair() {
        let first = ActivePluginInvocation::register("repair-a", "invocation-1").unwrap();
        let second = ActivePluginInvocation::register("repair-b", "invocation-1").unwrap();

        cancel_all_plugin_invocations();

        assert!(first.cancelled.load(Ordering::Acquire));
        assert!(second.cancelled.load(Ordering::Acquire));
    }
