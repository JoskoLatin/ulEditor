// No console window beside the GUI on Windows in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    uleditor_lib::run();
}
