#[cfg(all(windows, feature = "desktop"))]
mod desktop;
pub mod media;
pub mod recording_gate;
#[cfg(all(windows, feature = "desktop"))]
pub use desktop::run;
