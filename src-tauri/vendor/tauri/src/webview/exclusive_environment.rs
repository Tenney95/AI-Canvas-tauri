// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Cold-maintenance-only environment factory. Must run on an initialized STA
//! before any webview for this profile; SDK failure is never downgraded to a lock.
use std::{os::windows::ffi::OsStrExt, path::Path, sync::{mpsc, Arc, atomic::{AtomicBool, Ordering}}};
use webview2_com::{
  Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2Environment,
    ICoreWebView2EnvironmentOptions, ICoreWebView2Environment5,
    ICoreWebView2Environment7, ICoreWebView2Environment10,
  },
  CoreWebView2EnvironmentOptions, CreateCoreWebView2EnvironmentCompletedHandler, BrowserProcessExitedEventHandler, CoTaskMemPWSTR,
};
use windows::core::{Error, HRESULT, Interface, PCWSTR, PWSTR};

/// Creates an environment with the SDK-enforced exclusive user-data-folder flag.
/// A controller must be constructed with the returned environment before treating
/// it as acquired; merely creating a new application lock is insufficient.
pub fn create_exclusive_webview2_environment(
  profile: &Path,
) -> Result<(ICoreWebView2Environment, Arc<AtomicBool>), &'static str> {
  let expected = profile.canonicalize().map_err(|_| "profile is unavailable")?;
  let profile: Vec<u16> = profile.as_os_str().encode_wide().chain(Some(0)).collect();
  let options = CoreWebView2EnvironmentOptions::default();
  let (tx, rx) = mpsc::channel();
  unsafe {
    options.set_exclusive_user_data_folder_access(true);
    CreateCoreWebView2EnvironmentWithOptions(
      PCWSTR::null(),
      PCWSTR(profile.as_ptr()),
      &ICoreWebView2EnvironmentOptions::from(options),
      &CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |status, environment| {
        let result = status.and_then(|_| {
          environment.ok_or_else(|| Error::from_hresult(HRESULT(0x80004005_u32 as i32)))
        });
        let _ = tx.send(result);
        Ok(())
      })),
    )
    .map_err(|_| "exclusive WebView2 environment unavailable")?;
  }
  let environment = webview2_com::wait_with_pump(rx)
    .map_err(|_| "exclusive WebView2 callback unavailable")?
    .map_err(|_| "profile is in use or exclusive access is unsupported")?;
  // Options2 became stable in SDK 1.0.1185.39. Environment10 was introduced in
  // 1.0.1210.39: conservatively require this newer interface instead of assuming
  // an older runtime honored an unknown options extension.
  environment.cast::<ICoreWebView2Environment10>()
    .map_err(|_| "runtime cannot prove exclusive profile support")?;
  let environment7 = environment.cast::<ICoreWebView2Environment7>()
    .map_err(|_| "runtime cannot report its actual profile")?;
  let mut actual = PWSTR::null();
  unsafe { environment7.UserDataFolder(&mut actual) }
    .map_err(|_| "runtime profile unavailable")?;
  let actual = std::path::PathBuf::from(CoTaskMemPWSTR::from(actual).to_string())
    .canonicalize().map_err(|_| "runtime profile unavailable")?;
  if actual != expected { return Err("runtime profile differs from the requested profile"); }
  let revoked = Arc::new(AtomicBool::new(false));
  let revoked_handler = revoked.clone();
  let mut token = 0;
  unsafe {
    environment.cast::<ICoreWebView2Environment5>()
      .map_err(|_| "runtime cannot observe browser termination")?
      .add_BrowserProcessExited(&BrowserProcessExitedEventHandler::create(Box::new(move |_, _| {
        revoked_handler.store(true, Ordering::Release);
        Ok(())
      })), &mut token)
      .map_err(|_| "browser termination observation unavailable")?;
  }
  Ok((environment, revoked))
}
