//! Capture identity is independent of a window's mutable/localized title.
#[derive(Debug, PartialEq, Eq)]
pub struct WindowCapture {
    pub handle: usize,
    pub process_id: u32,
}
impl WindowCapture {
    pub fn from_target_id(id: &str) -> Result<Self, String> {
        let invalid = || "ウィンドウ情報が不正です。録画対象を再選択してください".to_string();
        let mut parts = id.strip_prefix("window-").ok_or_else(invalid)?.split('-');
        let handle = parts
            .next()
            .ok_or_else(invalid)?
            .parse::<usize>()
            .map_err(|_| invalid())?;
        let process_id = parts
            .next()
            .ok_or_else(invalid)?
            .parse::<u32>()
            .map_err(|_| invalid())?;
        if handle == 0 || process_id == 0 || parts.next().is_some() {
            return Err(invalid());
        }
        Ok(Self { handle, process_id })
    }
    pub fn ffmpeg_input(&self) -> String {
        format!("hwnd={}", self.handle)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uses_numeric_window_identity_without_title_lookup() {
        let window = WindowCapture::from_target_id("window-524390-1234").unwrap();
        assert_eq!(window.ffmpeg_input(), "hwnd=524390");
        assert_eq!(window.process_id, 1234);
    }
    #[test]
    fn distinguishes_windows_with_identical_titles() {
        let a = WindowCapture::from_target_id("window-100-500").unwrap();
        let b = WindowCapture::from_target_id("window-200-500").unwrap();
        assert_ne!(a.ffmpeg_input(), b.ffmpeg_input());
    }
    #[test]
    fn rejects_missing_zero_overflow_and_extra_identity_fields() {
        for id in [
            "desktop",
            "window-100",
            "window-0-1",
            "window-1-0",
            "window-x-2",
            "window-1-2-extra",
            "window-18446744073709551616-1",
            "window-1-4294967296",
        ] {
            assert!(WindowCapture::from_target_id(id).is_err(), "{id}");
        }
    }
}
