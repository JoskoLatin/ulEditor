// Bez konzolnog prozora uz GUI na Windowsu u release buildu.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    uleditor_lib::run();
}
