use super::*;
use std::{
    ffi::{OsStr, OsString},
    os::windows::ffi::{OsStrExt, OsStringExt},
};
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{
            ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS,
        },
        System::Registry::{
            RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER,
            HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY, REG_SAM_FLAGS,
            RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RRF_ZEROONFAILURE,
        },
    },
};

const APP_PATHS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\App Paths\blender.exe";
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
const STEAM_KEY: &str = r"Software\Valve\Steam";
const MAX_REGISTRY_VALUE_BYTES: u32 = 32 * 1024;
const MAX_UNINSTALL_SUBKEYS: u32 = 4096;
const MAX_REGISTRY_SUBKEY_CHARS: usize = 256;

#[derive(Clone, Copy)]
struct RegistryLocation {
    hive: HKEY,
    view: REG_SAM_FLAGS,
}

struct OwnedRegistryKey(HKEY);

impl Drop for OwnedRegistryKey {
    fn drop(&mut self) {
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

fn registry_locations() -> [RegistryLocation; 4] {
    [
        RegistryLocation {
            hive: HKEY_CURRENT_USER,
            view: KEY_WOW64_64KEY,
        },
        RegistryLocation {
            hive: HKEY_CURRENT_USER,
            view: KEY_WOW64_32KEY,
        },
        RegistryLocation {
            hive: HKEY_LOCAL_MACHINE,
            view: KEY_WOW64_64KEY,
        },
        RegistryLocation {
            hive: HKEY_LOCAL_MACHINE,
            view: KEY_WOW64_32KEY,
        },
    ]
}

fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn open_key(location: RegistryLocation, subkey: &str) -> Result<Option<OwnedRegistryKey>, ()> {
    let subkey = wide_null(OsStr::new(subkey));
    let mut opened = HKEY(std::ptr::null_mut());
    let status = unsafe {
        RegOpenKeyExW(
            location.hive,
            PCWSTR(subkey.as_ptr()),
            0,
            KEY_READ | location.view,
            &mut opened,
        )
    };
    if status == ERROR_SUCCESS {
        Ok(Some(OwnedRegistryKey(opened)))
    } else if status == ERROR_FILE_NOT_FOUND {
        Ok(None)
    } else {
        Err(())
    }
}

fn query_string(
    key: &OwnedRegistryKey,
    subkey: Option<&str>,
    value_name: Option<&str>,
) -> Result<Option<OsString>, ()> {
    let subkey_wide = subkey.map(|value| wide_null(OsStr::new(value)));
    let value_wide = value_name.map(|value| wide_null(OsStr::new(value)));
    let subkey_pointer = subkey_wide
        .as_ref()
        .map_or(PCWSTR(std::ptr::null()), |value| PCWSTR(value.as_ptr()));
    let value_pointer = value_wide
        .as_ref()
        .map_or(PCWSTR(std::ptr::null()), |value| PCWSTR(value.as_ptr()));
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_ZEROONFAILURE;
    let mut byte_count = 0u32;
    let first_status = unsafe {
        RegGetValueW(
            key.0,
            subkey_pointer,
            value_pointer,
            flags,
            None,
            None,
            Some(&mut byte_count),
        )
    };
    if first_status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if first_status != ERROR_SUCCESS
        || byte_count == 0
        || byte_count > MAX_REGISTRY_VALUE_BYTES
        || byte_count % 2 != 0
    {
        return Err(());
    }

    let mut buffer = vec![0u16; (byte_count / 2) as usize];
    let second_status = unsafe {
        RegGetValueW(
            key.0,
            subkey_pointer,
            value_pointer,
            flags,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut byte_count),
        )
    };
    if second_status != ERROR_SUCCESS || byte_count % 2 != 0 {
        return Err(());
    }
    let written = (byte_count / 2) as usize;
    if written > buffer.len() {
        return Err(());
    }
    buffer.truncate(written);
    while buffer.last() == Some(&0) {
        buffer.pop();
    }
    if buffer.is_empty() {
        return Ok(None);
    }
    Ok(Some(OsString::from_wide(&buffer)))
}

fn enumerate_subkeys(key: &OwnedRegistryKey) -> (Vec<String>, bool, bool) {
    let mut names = Vec::new();
    let mut partial = false;
    let mut truncated = false;
    for index in 0..MAX_UNINSTALL_SUBKEYS {
        let mut buffer = [0u16; MAX_REGISTRY_SUBKEY_CHARS];
        let mut length = (buffer.len() - 1) as u32;
        let status = unsafe {
            RegEnumKeyExW(
                key.0,
                index,
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
                None,
                PWSTR(std::ptr::null_mut()),
                None,
                None,
            )
        };
        if status == ERROR_NO_MORE_ITEMS {
            return (names, partial, truncated);
        }
        if status == ERROR_MORE_DATA {
            partial = true;
            continue;
        }
        if status != ERROR_SUCCESS {
            partial = true;
            return (names, partial, truncated);
        }
        let Ok(name) = String::from_utf16(&buffer[..length as usize]) else {
            partial = true;
            continue;
        };
        names.push(name);
    }
    truncated = true;
    (names, partial, truncated)
}

fn push_hint(result: &mut DirectDiscoveryHints, hint: DirectDiscoveryHint) {
    if result.hints.len() >= MAX_DIRECT_DISCOVERY_HINTS {
        result.truncated = true;
        return;
    }
    result.hints.push(hint);
}

fn collect_app_paths(result: &mut DirectDiscoveryHints) {
    for location in registry_locations() {
        let key = match open_key(location, APP_PATHS_KEY) {
            Ok(Some(key)) => key,
            Ok(None) => continue,
            Err(()) => {
                result.partial = true;
                continue;
            }
        };
        match query_string(&key, None, None) {
            Ok(Some(path)) => push_hint(
                result,
                DirectDiscoveryHint {
                    source: BlenderInstallationSource::WindowsAppPaths,
                    executable_path: PathBuf::from(path),
                    display_name: "Blender（Windows 应用注册）".to_string(),
                    version_hint: None,
                },
            ),
            Ok(None) => {}
            Err(()) => result.partial = true,
        }
    }
}

fn collect_uninstall_entries(result: &mut DirectDiscoveryHints) {
    for location in registry_locations() {
        let key = match open_key(location, UNINSTALL_KEY) {
            Ok(Some(key)) => key,
            Ok(None) => continue,
            Err(()) => {
                result.partial = true;
                continue;
            }
        };
        let (subkeys, partial, truncated) = enumerate_subkeys(&key);
        result.partial |= partial;
        result.truncated |= truncated;
        for subkey in subkeys {
            let display_name = match query_string(&key, Some(&subkey), Some("DisplayName")) {
                Ok(Some(value)) => match value.into_string() {
                    Ok(value) if is_blender_product_display_name(&value) => value,
                    _ => continue,
                },
                Ok(None) => continue,
                Err(()) => {
                    result.partial = true;
                    continue;
                }
            };
            let install_location =
                match query_string(&key, Some(&subkey), Some("InstallLocation")) {
                    Ok(Some(value)) => value,
                    Ok(None) => continue,
                    Err(()) => {
                        result.partial = true;
                        continue;
                    }
                };
            let version_hint = query_string(&key, Some(&subkey), Some("DisplayVersion"))
                .ok()
                .flatten()
                .and_then(|value| value.into_string().ok())
                .and_then(|value| normalize_numeric_version_hint(&value));
            push_hint(
                result,
                DirectDiscoveryHint {
                    source: BlenderInstallationSource::WindowsUninstall,
                    executable_path: PathBuf::from(install_location)
                        .join(BLENDER_EXECUTABLE_NAME),
                    display_name,
                    version_hint,
                },
            );
        }
    }
}

fn collect_path_entries(result: &mut DirectDiscoveryHints) {
    let Some(path) = std::env::var_os("PATH") else {
        return;
    };
    let mut paths = std::env::split_paths(&path);
    for directory in paths.by_ref().take(MAX_PATH_ENTRIES) {
        push_hint(
            result,
            DirectDiscoveryHint {
                source: BlenderInstallationSource::EnvironmentPath,
                executable_path: directory.join(BLENDER_EXECUTABLE_NAME),
                display_name: "Blender（PATH）".to_string(),
                version_hint: None,
            },
        );
    }
    if paths.next().is_some() {
        result.truncated = true;
    }
}

fn collect_steam_roots(result: &mut DirectDiscoveryHints) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for location in registry_locations() {
        let key = match open_key(location, STEAM_KEY) {
            Ok(Some(key)) => key,
            Ok(None) => continue,
            Err(()) => {
                result.partial = true;
                continue;
            }
        };
        for value_name in ["InstallPath", "SteamPath"] {
            match query_string(&key, None, Some(value_name)) {
                Ok(Some(path)) => roots.push(PathBuf::from(path)),
                Ok(None) => {}
                Err(()) => result.partial = true,
            }
        }
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        roots.push(PathBuf::from(program_files_x86).join("Steam"));
    }
    roots.sort_by_key(|path| path.to_string_lossy().to_lowercase());
    roots.dedup_by(|left, right| left.as_os_str().eq_ignore_ascii_case(right.as_os_str()));
    roots
}

fn collect_steam_entries(result: &mut DirectDiscoveryHints) {
    let steam_roots = collect_steam_roots(result);
    for steam_root in steam_roots {
        let mut library_roots = vec![steam_root.clone()];
        let library_file = steam_root.join("steamapps").join("libraryfolders.vdf");
        if let Some(body) = read_bounded_utf8_file(&library_file, MAX_STEAM_METADATA_BYTES) {
            for value in vdf_values(&body, "path") {
                if library_roots.len() >= MAX_STEAM_LIBRARY_ROOTS {
                    result.truncated = true;
                    break;
                }
                library_roots.push(PathBuf::from(value));
            }
        }
        library_roots.sort_by_key(|path| path.to_string_lossy().to_lowercase());
        library_roots
            .dedup_by(|left, right| left.as_os_str().eq_ignore_ascii_case(right.as_os_str()));

        for library_root in library_roots {
            let steamapps = library_root.join("steamapps");
            let manifest = steamapps.join(format!("appmanifest_{STEAM_BLENDER_APP_ID}.acf"));
            let Some(body) = read_bounded_utf8_file(&manifest, MAX_STEAM_METADATA_BYTES) else {
                continue;
            };
            if vdf_values(&body, "appid")
                .first()
                .is_none_or(|value| value != STEAM_BLENDER_APP_ID)
            {
                continue;
            }
            let Some(install_directory) = vdf_values(&body, "installdir")
                .into_iter()
                .next()
                .filter(|value| is_safe_single_path_component(value))
            else {
                result.partial = true;
                continue;
            };
            push_hint(
                result,
                DirectDiscoveryHint {
                    source: BlenderInstallationSource::Steam,
                    executable_path: steamapps
                        .join("common")
                        .join(install_directory)
                        .join(BLENDER_EXECUTABLE_NAME),
                    display_name: "Blender（Steam）".to_string(),
                    version_hint: None,
                },
            );
        }
    }
}

pub(super) fn collect_direct_hints() -> DirectDiscoveryHints {
    let mut result = DirectDiscoveryHints::default();
    collect_app_paths(&mut result);
    collect_uninstall_entries(&mut result);
    collect_path_entries(&mut result);
    collect_steam_entries(&mut result);
    result
}
