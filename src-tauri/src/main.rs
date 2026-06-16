#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // --onnx-worker 模式：独立的推理子进程
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && args[1] == "--onnx-worker" {
        ai_canvas_tauri_lib::onnx::worker::run();
        return;
    }

    ai_canvas_tauri_lib::run();
}
