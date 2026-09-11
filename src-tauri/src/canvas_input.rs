//! Mac 普通滚轮接入画布；精确滚动、手势和其他窗口保留 AppKit/WebKit 原事件。

use tauri::{plugin::TauriPlugin, Runtime};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = tauri::plugin::Builder::new("canvas-input");
    #[cfg(target_os = "macos")]
    let builder = builder
        .on_webview_ready(|webview| {
            if webview.label() == "main" {
                if let Err(_error) = webview.with_webview(|platform| unsafe {
                    // Tauri 提供当前主窗口的 WKWebView；install 在主线程取得自己的 retain。
                    macos::install(platform.inner().cast());
                }) {
                    eprintln!("[canvas-input] 原生滚轮适配不可用，保留 WebKit 输入");
                }
            }
        })
        .on_event(|_, event| match event {
            tauri::RunEvent::Exit => macos::shutdown(),
            tauri::RunEvent::WindowEvent { label, event, .. } if label == "main" => match event {
                tauri::WindowEvent::Destroyed => macos::shutdown(),
                tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Resized(_) => {
                    macos::cancel_pending();
                }
                _ => {}
            },
            _ => {}
        });
    builder.build()
}

#[cfg(any(target_os = "macos", test))]
mod routing {
    use std::collections::VecDeque;

    pub const MAX_PENDING: usize = 128;

    #[derive(Default)]
    pub struct WheelFacts {
        pub precise: bool,
        pub phase: usize,
        pub momentum_phase: usize,
        pub modified: bool,
        pub buttons: usize,
        pub delta_x: f64,
        pub delta_y: f64,
    }

    impl WheelFacts {
        pub fn zoom_delta(&self) -> Option<f64> {
            // 不用整数、步幅或事件频率猜设备；任意触摸板阶段（含结束）均原样放行。
            if self.precise
                || self.phase != 0
                || self.momentum_phase != 0
                || self.modified
                || self.buttons != 0
                || self.delta_x != 0.0
                || !self.delta_y.is_finite()
                || self.delta_y == 0.0
            {
                return None;
            }
            // AppKit 非精确 scrollingDelta 为行单位，沿用前端 DOM_DELTA_LINE 的 40 倍归一化。
            let delta = -self.delta_y * 40.0;
            delta.is_finite().then_some(delta)
        }
    }

    struct Pending<T> {
        id: u64,
        event: T,
        consumed: Option<bool>,
    }

    pub struct PendingWheels<T> {
        next_id: u64,
        events: VecDeque<Pending<T>>,
    }

    impl<T> Default for PendingWheels<T> {
        fn default() -> Self {
            Self {
                next_id: 0,
                events: VecDeque::new(),
            }
        }
    }

    impl<T> PendingWheels<T> {
        pub fn push(&mut self, event: T) -> Option<u64> {
            if self.events.len() >= MAX_PENDING {
                return None;
            }
            self.next_id = self.next_id.checked_add(1)?;
            self.events.push_back(Pending {
                id: self.next_id,
                event,
                consumed: None,
            });
            Some(self.next_id)
        }

        pub fn resolve(&mut self, id: u64, consumed: bool) -> Vec<T> {
            let Some(pending) = self.events.iter_mut().find(|entry| entry.id == id) else {
                return vec![];
            };
            if pending.consumed.is_some() {
                return vec![];
            }
            pending.consumed = Some(consumed);
            let mut replay = Vec::new();
            // WebKit 回调即使乱序，未消费的原事件也只能按原顺序恢复，且仅恢复一次。
            while self
                .events
                .front()
                .is_some_and(|entry| entry.consumed.is_some())
            {
                if let Some(entry) = self.events.pop_front() {
                    if entry.consumed == Some(false) {
                        replay.push(entry.event);
                    }
                }
            }
            replay
        }

        pub fn clear(&mut self) {
            self.events.clear();
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::routing::{PendingWheels, WheelFacts};
    use block2::RcBlock;
    use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use objc2_foundation::{NSError, NSNumber, NSProcessInfo, NSString};
    use objc2_web_kit::WKWebView;
    use serde::Serialize;
    use std::{
        cell::{Cell, RefCell},
        ptr::NonNull,
        rc::Rc,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct MouseWheelInput {
        x_ratio: f64,
        y_ratio: f64,
        delta_y: f64,
        issued_at: f64,
    }

    struct State {
        webview: Retained<WKWebView>,
        pending: RefCell<PendingWheels<Retained<NSEvent>>>,
        replaying: Cell<*const NSEvent>,
        closed: Cell<bool>,
        routing_active: Cell<bool>,
    }

    struct Monitor {
        token: Retained<AnyObject>,
        state: Rc<State>,
    }

    thread_local! {
        // AppKit 监听器、Retained WebView 与回调均只在主线程使用，不跨线程伪造 Send。
        static MONITOR: RefCell<Option<Monitor>> = const { RefCell::new(None) };
    }

    impl State {
        fn cancel(&self) {
            self.pending.borrow_mut().clear();
            if !self.routing_active.replace(false) {
                return;
            }
            unsafe {
                // 同一 WebView 的脚本通道中取消已排队缩放；不派发或阻止任何触摸板事件。
                self.webview.evaluateJavaScript_completionHandler(
                    &NSString::from_str(
                        "window.dispatchEvent(new Event('ai-canvas:native-wheel-cancel'))",
                    ),
                    None,
                );
            }
        }

        fn receive(self: &Rc<Self>, event: &NSEvent, mtm: MainThreadMarker) -> bool {
            let Some(window) = self.webview.window() else {
                return false;
            };
            if self.closed.get()
                || event.windowNumber() != window.windowNumber()
                || !window.isKeyWindow()
                || !window.isVisible()
                || self.webview.isHiddenOrHasHiddenAncestor()
            {
                return false;
            }
            if event.r#type() != NSEventType::ScrollWheel {
                self.cancel();
                return false;
            }
            let flags = NSEventModifierFlags::Control
                | NSEventModifierFlags::Command
                | NSEventModifierFlags::Shift
                | NSEventModifierFlags::Option;
            let facts = WheelFacts {
                precise: event.hasPreciseScrollingDeltas(),
                phase: event.phase().0,
                momentum_phase: event.momentumPhase().0,
                modified: event.modifierFlags().intersects(flags),
                buttons: NSEvent::pressedMouseButtons(),
                delta_x: event.scrollingDeltaX(),
                delta_y: event.scrollingDeltaY(),
            };
            let Some(delta_y) = facts.zoom_delta() else {
                self.cancel();
                return false;
            };
            let bounds = self.webview.bounds();
            if bounds.size.width <= 0.0 || bounds.size.height <= 0.0 {
                return false;
            }
            let point = self
                .webview
                .convertPoint_fromView(event.locationInWindow(), None);
            let x_ratio = (point.x - bounds.origin.x) / bounds.size.width;
            let y = (point.y - bounds.origin.y) / bounds.size.height;
            let y_ratio = if self.webview.isFlipped() { y } else { 1.0 - y };
            if !(0.0..1.0).contains(&x_ratio) || !(0.0..1.0).contains(&y_ratio) {
                return false;
            }
            // 排除主窗口内的其他原生视图（例如停靠的开发工具）。
            if let Some(content) = window.contentView() {
                // hitTest 使用接收者的父视图坐标，不是接收者自身的 bounds 坐标。
                // 主线程中 window/content 的 retain 保持视图树存活，期间没有移除视图。
                let parent = unsafe { content.superview() };
                let hit_point = parent.map_or_else(
                    || event.locationInWindow(),
                    |parent| parent.convertPoint_fromView(event.locationInWindow(), None),
                );
                if !content
                    .hitTest(hit_point)
                    .is_some_and(|hit| hit.isDescendantOf(&self.webview))
                {
                    return false;
                }
            } else {
                return false;
            }
            let Ok(wall_time) = SystemTime::now().duration_since(UNIX_EPOCH) else {
                return false;
            };
            let age = (NSProcessInfo::processInfo().systemUptime() - event.timestamp()).max(0.0);
            let issued_at = wall_time.as_secs_f64() * 1000.0 - age * 1000.0;
            if !issued_at.is_finite() {
                return false;
            }
            let Ok(json) = serde_json::to_string(&MouseWheelInput {
                x_ratio,
                y_ratio,
                delta_y,
                issued_at,
            }) else {
                return false;
            };
            // 原始 NSEvent 保留到前端回执；未知/未消费时交回 AppKit，不模拟编辑区滚动。
            let retained = unsafe { Retained::retain(event as *const NSEvent as *mut NSEvent) };
            let Some(retained) = retained else {
                return false;
            };
            let id = self.pending.borrow_mut().push(retained);
            let Some(id) = id else {
                self.cancel();
                return false;
            };
            self.routing_active.set(true);
            let weak = Rc::downgrade(self);
            let completion = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                let Some(state) = weak.upgrade() else {
                    return;
                };
                if state.closed.get() {
                    return;
                }
                let consumed = error.is_null()
                    && unsafe { result.as_ref() }
                        .and_then(|value| value.downcast_ref::<NSNumber>())
                        .is_some_and(|value| value.boolValue());
                let replay = state.pending.borrow_mut().resolve(id, consumed);
                for original in replay {
                    let Some(window) = state.webview.window() else {
                        break;
                    };
                    if !window.isKeyWindow() || !window.isVisible() {
                        break;
                    }
                    // 同步 sendEvent 期间只放行这一个原始指针，避免被监听器再次捕获。
                    state.replaying.set(Retained::as_ptr(&original));
                    NSApplication::sharedApplication(mtm).sendEvent(&original);
                    state.replaying.set(std::ptr::null());
                }
            });
            unsafe {
                self.webview.evaluateJavaScript_completionHandler(
                    &NSString::from_str(&format!("!window.dispatchEvent(new CustomEvent('ai-canvas:native-mouse-wheel',{{cancelable:true,detail:{json}}}))")),
                    Some(&completion),
                );
            }
            true
        }
    }

    pub unsafe fn install(webview: *mut WKWebView) {
        let Some(_mtm) = MainThreadMarker::new() else {
            return;
        };
        shutdown();
        let Some(webview) = (unsafe { Retained::retain(webview) }) else {
            return;
        };
        let state = Rc::new(State {
            webview,
            pending: RefCell::new(PendingWheels::default()),
            replaying: Cell::new(std::ptr::null()),
            closed: Cell::new(false),
            routing_active: Cell::new(false),
        });
        let weak = Rc::downgrade(&state);
        let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            let Some(state) = weak.upgrade() else {
                return event.as_ptr();
            };
            if state.replaying.get() == event.as_ptr() {
                return event.as_ptr();
            }
            let Some(mtm) = MainThreadMarker::new() else {
                return event.as_ptr();
            };
            if state.receive(unsafe { event.as_ref() }, mtm) {
                std::ptr::null_mut()
            } else {
                event.as_ptr()
            }
        });
        let mask = NSEventMask::ScrollWheel
            | NSEventMask::LeftMouseDown
            | NSEventMask::RightMouseDown
            | NSEventMask::OtherMouseDown
            | NSEventMask::KeyDown
            | NSEventMask::FlagsChanged
            | NSEventMask::Magnify
            | NSEventMask::BeginGesture;
        // 监听的是本应用分派链；不安装全局事件监听，不要求辅助功能权限。
        if let Some(token) =
            unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &handler) }
        {
            MONITOR.with(|monitor| *monitor.borrow_mut() = Some(Monitor { token, state }));
        }
    }

    pub fn cancel_pending() {
        MONITOR.with(|monitor| {
            if let Some(monitor) = monitor.borrow().as_ref() {
                monitor.state.cancel();
            }
        });
    }

    pub fn shutdown() {
        let monitor = MONITOR.with(|monitor| monitor.borrow_mut().take());
        if let Some(monitor) = monitor {
            monitor.state.closed.set(true);
            monitor.state.pending.borrow_mut().clear();
            unsafe {
                NSEvent::removeMonitor(&monitor.token);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::routing::{PendingWheels, WheelFacts, MAX_PENDING};

    #[test]
    fn discrete_wheel_keeps_continuous_delta_and_direction() {
        for value in [3.0, -3.0, 0.25, 30.0] {
            assert_eq!(
                WheelFacts {
                    delta_y: value,
                    ..Default::default()
                }
                .zoom_delta(),
                Some(-value * 40.0)
            );
        }
    }

    #[test]
    fn precise_gestures_momentum_and_modified_inputs_are_never_routed() {
        let cases = [
            WheelFacts {
                precise: true,
                delta_y: 3.0,
                ..Default::default()
            },
            WheelFacts {
                phase: 8,
                delta_y: 3.0,
                ..Default::default()
            },
            WheelFacts {
                momentum_phase: 1,
                delta_y: 3.0,
                ..Default::default()
            },
            WheelFacts {
                modified: true,
                delta_y: 3.0,
                ..Default::default()
            },
            WheelFacts {
                buttons: 1,
                delta_y: 3.0,
                ..Default::default()
            },
            WheelFacts {
                delta_x: 0.1,
                delta_y: 3.0,
                ..Default::default()
            },
            WheelFacts {
                delta_y: f64::NAN,
                ..Default::default()
            },
            WheelFacts {
                delta_y: f64::MAX,
                ..Default::default()
            },
            WheelFacts::default(),
        ];
        for facts in cases {
            assert_eq!(facts.zoom_delta(), None);
        }
    }

    #[test]
    fn callbacks_restore_only_unconsumed_events_once_in_original_order() {
        let mut pending = PendingWheels::default();
        let first = pending.push("panel-1").unwrap();
        let second = pending.push("canvas").unwrap();
        let third = pending.push("panel-2").unwrap();
        assert!(pending.resolve(third, false).is_empty());
        assert!(pending.resolve(third, true).is_empty());
        assert!(pending.resolve(second, true).is_empty());
        assert_eq!(pending.resolve(first, false), vec!["panel-1", "panel-2"]);
        assert!(pending.resolve(first, false).is_empty());
    }

    #[test]
    fn cancellation_discards_old_receipts_without_touching_a_new_gesture() {
        let mut pending = PendingWheels::default();
        let old = pending.push(1).unwrap();
        pending.clear();
        let current = pending.push(2).unwrap();
        assert!(pending.resolve(old, false).is_empty());
        assert_eq!(pending.resolve(current, false), vec![2]);
    }

    #[test]
    fn pending_native_events_are_bounded() {
        let mut pending = PendingWheels::default();
        for n in 0..MAX_PENDING {
            assert!(pending.push(n).is_some());
        }
        assert!(pending.push(MAX_PENDING).is_none());
        pending.clear();
        assert!(pending.push(MAX_PENDING + 1).is_some());
    }
}
