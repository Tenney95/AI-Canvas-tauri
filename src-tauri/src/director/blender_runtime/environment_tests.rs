use super::*;

fn decode_environment(block: &[u16]) -> HashMap<String, String> {
    block
        .split(|value| *value == 0)
        .take_while(|entry| !entry.is_empty())
        .map(|entry| String::from_utf16(entry).expect("环境块应为 UTF-16"))
        .map(|entry| {
            let (name, value) = entry.split_once('=').expect("环境项应包含等号");
            (name.to_ascii_uppercase(), value.to_string())
        })
        .collect()
}

#[test]
fn blender_environment_reuses_default_user_directories_without_path_overrides() {
    let inherited = [
        (
            OsString::from("APPDATA"),
            OsString::from(r"C:\Users\Tester\AppData\Roaming"),
        ),
        (
            OsString::from("BLENDER_USER_CONFIG"),
            OsString::from(r"C:\untrusted-config"),
        ),
        (
            OsString::from("BLENDER_USER_SCRIPTS"),
            OsString::from(r"C:\untrusted-scripts"),
        ),
        (
            OsString::from("BLENDER_SYSTEM_SCRIPTS"),
            OsString::from(r"C:\untrusted-system-scripts"),
        ),
        (
            OsString::from("PYTHONPATH"),
            OsString::from(r"C:\untrusted-python"),
        ),
    ];
    let block = build_windows_environment_from(inherited).expect("应能构造 Blender 环境");
    let environment = decode_environment(&block);

    assert_eq!(
        environment.get("APPDATA").map(String::as_str),
        Some(r"C:\Users\Tester\AppData\Roaming")
    );
    assert!(!environment.contains_key("BLENDER_USER_CONFIG"));
    assert!(!environment.contains_key("BLENDER_USER_SCRIPTS"));
    assert!(!environment.contains_key("BLENDER_SYSTEM_SCRIPTS"));
    assert!(!environment.contains_key("PYTHONPATH"));
}

#[test]
fn editor_inherits_preferences_while_background_jobs_use_factory_startup() {
    let executable = Path::new(r"C:\Blender\blender.exe");
    let startup_blend = Path::new(r"C:\AI Canvas\startup.blend");
    let template_init = Path::new(r"C:\AI Canvas\__init__.py");
    let job_script = Path::new(r"C:\AI Canvas\job.py");

    let editor =
        build_blender_arguments(executable, startup_blend, template_init, job_script, false);
    assert!(!editor.contains(&OsString::from("--background")));
    assert!(!editor.contains(&OsString::from("--factory-startup")));
    assert!(!editor.contains(&OsString::from("--app-template")));
    assert!(editor.contains(&startup_blend.as_os_str().to_owned()));
    assert!(editor.contains(&template_init.as_os_str().to_owned()));
    assert_eq!(
        editor
            .iter()
            .filter(|argument| argument.as_os_str() == "--python")
            .count(),
        2
    );

    let background =
        build_blender_arguments(executable, startup_blend, template_init, job_script, true);
    assert!(background.contains(&OsString::from("--background")));
    assert!(background.contains(&OsString::from("--factory-startup")));
    assert!(background.contains(&OsString::from("--disable-autoexec")));
    assert!(!background.contains(&OsString::from("--app-template")));
}

#[test]
fn editor_inherits_parent_environment_while_background_jobs_are_sanitized() {
    assert!(build_windows_environment_for(false)
        .expect("编辑器环境模式应可构造")
        .is_none());
    assert!(build_windows_environment_for(true)
        .expect("后台环境模式应可构造")
        .is_some());
}
