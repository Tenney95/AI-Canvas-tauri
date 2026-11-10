//! Native-only script results; never navigate the page or expose application IPC.
use super::{muse_url, random_id, DELIVERY_UNCONFIRMED, WINDOW_LOADS};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::Mutex, time::Duration};
use tauri::WebviewWindow;
use tokio::{sync::oneshot, time::Instant};

const MAX_REPLY_BYTES: usize = 100_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    ok: bool,
    #[serde(default)] value: Value,
    #[serde(default)] code: Option<String>,
}

fn page_failure(code: Option<&str>) -> &'static str {
    match code {
        Some("not-ready") => "Muse 网页尚未准备完成，尚未发送生成请求",
        Some("not-new-thread") => "Muse 页面不是空白新对话，尚未发送生成请求",
        Some("upload-unavailable") => "Muse 网页未提供可用的参考图上传入口，尚未发送生成请求",
        Some("upload-data") => "Muse 参考图数据无法转换为网页附件，尚未发送生成请求",
        Some("upload-selection") => "Muse 网页未接受参考图文件，尚未发送生成请求",
        Some("upload-dispatch") => "Muse 网页未确认参考图上传事件，尚未发送生成请求",
        Some("upload-unconfirmed") => "Muse 参考图上传未确认完成，尚未发送生成请求",
        Some("composer-unavailable") => "Muse 网页输入框不可用，尚未发送生成请求",
        Some("send-unavailable") => "Muse 网页发送按钮尚未就绪，尚未发送生成请求",
        Some("send-unconfirmed") => DELIVERY_UNCONFIRMED,
        Some("session-unconfirmed") => "Muse 官网暂未确认登录会话，尚未发送生成请求",
        Some("session-size") => "Muse 登录会话响应超出大小限制，尚未发送生成请求",
        _ => "Muse 页面操作未确认，未自动重新发送",
    }
}

fn current(window: &WebviewWindow, instance: u64) -> bool {
    WINDOW_LOADS.lock().ok().is_some_and(|loads| loads.get(window.label())
        .is_some_and(|load| load.native_ready && load.instance == instance))
}

struct PageSlot { window: WebviewWindow, key: String, instance: u64 }
impl Drop for PageSlot {
    fn drop(&mut self) {
        if current(&self.window, self.instance) {
            let _ = self.window.eval(format!("if(location.origin==='https://muse.ai')delete window[{}];", json!(self.key)));
        }
    }
}

async fn native_result(window: &WebviewWindow, script: String, deadline: Instant) -> Result<Value, String> {
    if Instant::now() >= deadline { return Err("Muse 页面响应超时，原任务已保留".into()); }
    let (sender, receiver) = oneshot::channel();
    let sender = Mutex::new(Some(sender));
    window.eval_with_callback(script, move |body| {
        // The native callback only bounds and forwards bytes. Parsing stays off the UI thread.
        let body = if body.len() <= MAX_REPLY_BYTES { Ok(body) } else { Err("Muse 页面响应超过大小限制".to_string()) };
        if let Ok(mut sender) = sender.lock() { if let Some(sender) = sender.take() { let _ = sender.send(body); } }
    }).map_err(|_| "Muse 页面执行失败")?;
    let body = tokio::time::timeout_at(deadline, receiver).await
        .map_err(|_| "Muse 页面响应超时，原任务已保留")?.map_err(|_| "Muse 页面响应中断")??;
    serde_json::from_str(&body).map_err(|_| "Muse 页面响应格式无效".into())
}

pub(super) async fn evaluate(window: &WebviewWindow, expression: &str, timeout: Duration) -> Result<Value, String> {
    let instance = WINDOW_LOADS.lock().map_err(|_| "Muse 加载状态不可用")?.get(window.label())
        .filter(|load| load.native_ready).map(|load| load.instance).ok_or("Muse 浏览器正在初始化，请稍后重试")?;
    if !window.url().is_ok_and(|url| muse_url(&url)) { return Err("Muse 网页尚未就绪".into()); }
    let deadline = Instant::now() + timeout;
    let slot = PageSlot { window: window.clone(), key: format!("__aiCanvasMuseEval_{}", random_id()?), instance };
    let key = json!(&slot.key);
    let start = format!(r#"(()=>{{
      if(location.origin!=='https://muse.ai')return false;
      const key={key},slot={{done:false,result:null}};
      Object.defineProperty(window,key,{{value:slot,configurable:true}});
      const finish=result=>{{
        if(window[key]!==slot)return;
        try{{const body=JSON.stringify(result);slot.result=body&&new TextEncoder().encode(body).length<={MAX_REPLY_BYTES}?body:'{{"ok":false}}';}}
        catch(_){{slot.result='{{"ok":false}}';}}
        slot.done=true;
      }};
      (async()=>{{try{{finish({{ok:true,value:await({expression})}});}}catch(error){{
        let code;try{{const message=error?.message;if(['not-ready','not-new-thread','upload-unavailable','upload-data','upload-selection','upload-dispatch','upload-unconfirmed','composer-unavailable','send-unavailable','send-unconfirmed','session-unconfirmed','session-size'].includes(message))code=message;}}catch(_){{}}
        finish({{ok:false,code}});
      }}}})();
      return true;
    }})()"#);
    if native_result(window, start, deadline).await? != Value::Bool(true) { return Err("Muse 网页尚未就绪".into()); }
    let probe = format!(r#"(()=>{{
      if(location.origin!=='https://muse.ai')return {{ok:false}};
      const slot=window[{key}];if(!slot)return {{ok:false}};
      if(!slot.done)return null;
      const result=JSON.parse(slot.result);delete window[{key}];return result;
    }})()"#);
    loop {
        if !current(window, instance) || !window.url().is_ok_and(|url| muse_url(&url)) { return Err("Muse 网页来源已变化，原任务已保留".into()); }
        let result = native_result(window, probe.clone(), deadline).await?;
        if !current(window, instance) || !window.url().is_ok_and(|url| muse_url(&url)) { return Err("Muse 网页来源已变化，原任务已保留".into()); }
        if !result.is_null() {
            let reply: Reply = serde_json::from_value(result).map_err(|_| "Muse 页面响应格式无效")?;
            if !reply.ok { return Err(page_failure(reply.code.as_deref()).into()); }
            return Ok(reply.value);
        }
        tokio::time::sleep_until((Instant::now() + Duration::from_millis(150)).min(deadline)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fixed_page_failure_codes_are_exposed() {
        assert_eq!(page_failure(Some("upload-unconfirmed")), "Muse 参考图上传未确认完成，尚未发送生成请求");
        assert_eq!(page_failure(Some("upload-data")), "Muse 参考图数据无法转换为网页附件，尚未发送生成请求");
        assert_eq!(page_failure(Some("upload-selection")), "Muse 网页未接受参考图文件，尚未发送生成请求");
        assert_eq!(page_failure(Some("upload-dispatch")), "Muse 网页未确认参考图上传事件，尚未发送生成请求");
        assert_eq!(page_failure(Some("send-unconfirmed")), DELIVERY_UNCONFIRMED);
        assert_eq!(page_failure(Some("session-unconfirmed")), "Muse 官网暂未确认登录会话，尚未发送生成请求");
        assert_eq!(page_failure(Some("session-size")), "Muse 登录会话响应超出大小限制，尚未发送生成请求");
        assert_eq!(page_failure(Some("fake-private-page-error")), page_failure(None));
        assert!(serde_json::from_value::<Reply>(json!({ "ok": false, "message": "fake-private-page-error" })).is_err());
    }
}
