//! 无界面宿主：没有显示器、没开 GUI 的设备上，经远程访问协议（设备 socket）服务本机项目。
//! 与 GUI 同一份后端（`berth_lib::run`），只把 Tauri 运行时换成 MockRuntime。

fn main() {
    berth_lib::run()
}
