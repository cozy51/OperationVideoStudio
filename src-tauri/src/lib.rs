pub mod capture;
#[cfg(all(windows, feature = "desktop"))]
mod desktop;
pub mod media;
pub mod recording_gate;
#[cfg(all(windows, feature = "desktop"))]
pub use desktop::run;

pub mod recording_storage;

pub mod annotations;

#[cfg(all(windows, feature = "desktop"))]
mod audio;

pub mod clicks;

pub mod recovery;
