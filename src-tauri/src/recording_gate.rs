//! A recording transition may wait for native UI dispatch. It must never hold
//! the recording-state mutex while doing so. This gate serializes transitions
//! without making status reads or the GUI thread acquire that mutex.
use std::sync::atomic::{AtomicBool, Ordering};
#[derive(Default)]
pub struct RecordingGate(AtomicBool);
pub struct Transition<'a>(&'a RecordingGate);
impl RecordingGate {
    pub fn enter(&self) -> Result<Transition<'_>, String> {
        self.0
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Transition(self))
            .map_err(|_| "録画の開始・停止処理中です。少し待ってから操作してください".into())
    }
    pub fn busy(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}
impl Drop for Transition<'_> {
    fn drop(&mut self) {
        self.0 .0.store(false, Ordering::SeqCst);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_can_be_read_during_start_and_concurrent_transitions_are_rejected() {
        let gate = RecordingGate::default();
        let transition = gate.enter().unwrap();
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    assert!(gate.busy());
                    assert!(gate.enter().is_err());
                })
                .join()
                .unwrap()
        });
        drop(transition);
        assert!(!gate.busy());
        assert!(gate.enter().is_ok());
    }
    #[test]
    fn failed_start_releases_the_gate_for_retry() {
        let gate = RecordingGate::default();
        let attempt = || -> Result<(), String> {
            let _transition = gate.enter()?;
            Err("FFmpeg not found".into())
        };
        assert!(attempt().is_err());
        assert!(!gate.busy());
        assert!(gate.enter().is_ok());
    }
}
