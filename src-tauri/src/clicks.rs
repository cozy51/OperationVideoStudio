use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Click {
    pub time: f64,
    pub x: f64,
    pub y: f64,
    pub media_id: String,
}
#[cfg(all(windows, feature = "desktop"))]
pub struct Recorder {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    join: Option<std::thread::JoinHandle<Result<(), String>>>,
    pub path: std::path::PathBuf,
}
#[cfg(all(windows, feature = "desktop"))]
impl Recorder {
    pub fn start(
        path: std::path::PathBuf,
        start: std::time::Instant,
        offset: f64,
        mut bounds: impl FnMut() -> Option<(i32, i32, i32, i32)> + Send + 'static,
        frame_width: i32,
        frame_height: i32,
    ) -> Result<Self, String> {
        use std::{
            io::Write,
            sync::atomic::{AtomicBool, Ordering},
            sync::Arc,
        };
        use windows_sys::Win32::{
            Foundation::POINT, UI::Input::KeyboardAndMouse::GetAsyncKeyState,
            UI::WindowsAndMessaging::GetCursorPos,
        };
        let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let join = std::thread::spawn(move || {
            let mut down = false;
            while !stopping.load(Ordering::SeqCst) {
                let pressed = unsafe { GetAsyncKeyState(1) } < 0;
                if pressed && !down {
                    let mut point = POINT { x: 0, y: 0 };
                    if unsafe { GetCursorPos(&mut point) } != 0 {
                        if let Some((x, y, w, h)) = bounds() {
                            if w > 0
                                && h > 0
                                && point.x >= x
                                && point.y >= y
                                && point.x < x + w
                                && point.y < y + h
                            {
                                let scale = (frame_width as f64 / w as f64)
                                    .min(frame_height as f64 / h as f64);
                                let px = (frame_width as f64 - w as f64 * scale) / 2.0
                                    + (point.x - x) as f64 * scale;
                                let py = (frame_height as f64 - h as f64 * scale) / 2.0
                                    + (point.y - y) as f64 * scale;
                                let click = Click {
                                    time: offset + start.elapsed().as_secs_f64(),
                                    x: px / frame_width as f64,
                                    y: py / frame_height as f64,
                                    media_id: String::new(),
                                };
                                serde_json::to_writer(&mut file, &click)
                                    .map_err(|e| e.to_string())?;
                                file.write_all(b"\n").map_err(|e| e.to_string())?;
                                file.flush().map_err(|e| e.to_string())?;
                            }
                        }
                    }
                }
                down = pressed;
                std::thread::sleep(std::time::Duration::from_millis(8));
            }
            file.sync_all().map_err(|e| e.to_string())
        });
        Ok(Self {
            stop,
            join: Some(join),
            path,
        })
    }
    pub fn stop(&mut self) -> Result<(), String> {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(join) = self.join.take() {
            join.join().map_err(|_| "クリック記録が終了しました")??;
        }
        Ok(())
    }
}
#[cfg(all(windows, feature = "desktop"))]
impl Drop for Recorder {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
