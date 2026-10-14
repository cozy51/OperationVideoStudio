#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    #[cfg(windows)]
    ovs::run();
    #[cfg(not(windows))]
    panic!("Operation Video Studio desktop requires Windows 10/11. Core tests work on Linux.");
}
