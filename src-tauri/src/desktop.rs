use crate::capture::WindowCapture;
use crate::media::{self, Media, Project};
use crate::recording_gate::RecordingGate;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{Emitter, Manager, State};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, POINT, RECT},
    Graphics::Gdi::{
        ClientToScreen, EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
    },
    UI::WindowsAndMessaging::{
        EnumWindows, GetClientRect, GetSystemMetrics, GetWindowRect, GetWindowTextLengthW,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
        SetWindowDisplayAffinity, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    },
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    id: String,
    name: String,
    kind: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordOptions {
    target: Target,
    cursor: bool,
    quality: String,
    #[serde(default)]
    microphone: bool,
    #[serde(default)]
    system_audio: bool,
    #[serde(default)]
    highlight_clicks: bool,
}
struct Recording {
    options: RecordOptions,
    dir: PathBuf,
    segments: Vec<PathBuf>,
    child: Option<Child>,
    elapsed: f64,
    started: Option<Instant>,
    audio: Option<crate::audio::AudioRecording>,
    audio_epoch: u64,
    first_video_epoch: Arc<AtomicU64>,
    progress_reader: Option<std::thread::JoinHandle<()>>,
    click_recorder: Option<crate::clicks::Recorder>,
    click_files: Vec<PathBuf>,
}
#[derive(Default)]
struct Backend {
    allowed: Mutex<HashSet<PathBuf>>,
    recording: Mutex<Option<Recording>>,
    recording_transition: RecordingGate,
    export: Mutex<Option<Arc<AtomicBool>>>,
    last_output: Mutex<Option<PathBuf>>,
    targets: Mutex<Vec<Target>>,
    region: Mutex<Option<Target>>,
    autosave_transition: Mutex<()>,
    outline_transition: Mutex<()>,
    outline_ready: AtomicBool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordStatus {
    active: bool,
    paused: bool,
    seconds: f64,
}
#[derive(Clone, Serialize)]
struct ExportEvent {
    progress: f64,
    done: bool,
    error: Option<String>,
}
fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "内部状態にアクセスできません".into())
}
fn approve(app: &tauri::AppHandle, backend: &Backend, path: &Path) -> Result<Media, String> {
    let cache = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("preview-cache");
    let media = media::prepare_preview(path, &cache)?;
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| e.to_string())?;
    if let Some(preview) = &media.preview_path {
        app.asset_protocol_scope()
            .allow_file(preview)
            .map_err(|e| e.to_string())?;
    }
    lock(&backend.allowed)?.insert(path);
    Ok(media)
}
fn check_project(backend: &Backend, p: &Project) -> Result<(), String> {
    media::validate(p)?;
    let allowed = lock(&backend.allowed)?;
    for m in &p.media {
        if m.kind.as_deref() == Some("gap") {
            continue;
        }
        let path =
            fs::canonicalize(&m.path).map_err(|_| format!("元動画が見つかりません: {}", m.name))?;
        if !allowed.contains(&path) {
            return Err("選択していない動画にはアクセスできません".into());
        }
    }
    Ok(())
}
#[derive(Serialize)]
struct ToolStatus {
    ready: bool,
    details: String,
    directory: Option<String>,
}
fn tools_status() -> ToolStatus {
    let result = media::check_tools(true);
    ToolStatus {
        ready: result.is_ok(),
        details: result.unwrap_or_else(|e| e),
        directory: media::configured_tool_directory().map(|p| p.to_string_lossy().into_owned()),
    }
}
#[tauri::command]
async fn recording_tools() -> Result<ToolStatus, String> {
    tauri::async_runtime::spawn_blocking(tools_status)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn choose_ffmpeg_folder(app: tauri::AppHandle) -> Result<Option<ToolStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backend = app.state::<Backend>();
        if backend.recording_transition.busy()
            || lock(&backend.recording)?.is_some()
            || lock(&backend.export)?.is_some()
        {
            return Err("録画・書き出し中はFFmpeg設定を変更できません".into());
        }
        let Some(mut directory) = rfd::FileDialog::new()
            .set_title("ffmpeg.exe と ffprobe.exe のあるフォルダー（bin）")
            .pick_folder()
        else {
            return Ok(None);
        };
        if !directory.join("ffmpeg.exe").is_file() && directory.join("bin/ffmpeg.exe").is_file() {
            directory = directory.join("bin");
        }
        let old = media::configured_tool_directory();
        media::set_tool_directory(Some(directory))?;
        if let Err(error) = media::check_tools(true) {
            let _ = media::set_tool_directory(old);
            return Err(error);
        }
        let saved = (|| -> Result<(), String> {
            let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let mut temporary = tempfile::NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?;
            temporary
                .write_all(
                    &serde_json::to_vec(&media::configured_tool_directory())
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
            temporary.as_file().sync_all().map_err(|e| e.to_string())?;
            temporary
                .persist(dir.join("ffmpeg-directory.json"))
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(error) = saved {
            let _ = media::set_tool_directory(old);
            return Err(error);
        }
        Ok(Some(tools_status()))
    })
    .await
    .map_err(|e| e.to_string())?
}
fn recording_folder_settings(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("recording-folder.json"))
}
fn choose_recording_directory(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let settings = recording_folder_settings(app)?;
    let last = crate::recording_storage::load_folder(&settings)?;
    let mut dialog = rfd::FileDialog::new().set_title("録画の保存先フォルダー");
    if let Some(folder) = last {
        dialog = dialog.set_directory(folder);
    }
    dialog
        .pick_folder()
        .map(|folder| crate::recording_storage::save_folder(&settings, &folder))
        .transpose()
}
#[tauri::command]
fn recording_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(
        crate::recording_storage::load_folder(&recording_folder_settings(&app)?)?
            .map(|p| p.to_string_lossy().into_owned()),
    )
}
#[tauri::command]
async fn choose_recording_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backend = app.state::<Backend>();
        if backend.recording_transition.busy() || lock(&backend.recording)?.is_some() {
            return Err("録画を停止してから保存先を変更してください".into());
        }
        Ok(choose_recording_directory(&app)?.map(|p| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn import_videos(app: tauri::AppHandle) -> Result<Vec<Media>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = rfd::FileDialog::new()
            .set_title("動画を追加")
            .add_filter("動画", &["mp4", "mov", "mkv", "avi", "webm", "m4v"])
            .pick_files()
            .unwrap_or_default();
        paths
            .iter()
            .map(|p| approve(&app, &app.state::<Backend>(), p))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn save_project(app: tauri::AppHandle, project: Project) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_project(&app.state::<Backend>(), &project)?;
        let Some(path) = rfd::FileDialog::new()
            .set_title("プロジェクトを保存")
            .add_filter("OVS プロジェクト", &["ovs.json"])
            .set_file_name("手順動画.ovs.json")
            .save_file()
        else {
            return Ok(false);
        };
        let parent = path.parent().ok_or("保存先が不正です")?;
        // Source media is never writable, including through a renamed extension or symlink.
        if path.exists()
            && lock(&app.state::<Backend>().allowed)?
                .contains(&fs::canonicalize(&path).map_err(|e| e.to_string())?)
        {
            return Err("元動画に上書きすることはできません".into());
        }
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temp.write_all(&serde_json::to_vec_pretty(&project).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        // Never replace an existing file, even if the native dialog offers overwrite.
        temp.persist_noclobber(path)
            .map_err(|_| "同名ファイルが存在します。新しい名前で保存してください")?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn open_project(app: tauri::AppHandle) -> Result<Option<Project>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = rfd::FileDialog::new()
            .set_title("プロジェクトを開く")
            .add_filter("JSON", &["json"])
            .pick_file()
        else {
            return Ok(None);
        };
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > 10_000_000 {
            return Err("プロジェクトファイルが大きすぎます".into());
        }
        let mut p: Project = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|_| "プロジェクトJSONを読み込めません")?;
        media::validate(&p)?;
        for m in &mut p.media {
            if m.kind.as_deref() == Some("gap") {
                continue;
            }
            let actual = approve(&app, &app.state::<Backend>(), Path::new(&m.path))?;
            m.preview_path = actual.preview_path;
            m.codec = actual.codec;
        }
        Ok(Some(p))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn autosave(app: tauri::AppHandle, project: Project) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backend = app.state::<Backend>();
        let _save = lock(&backend.autosave_transition)?;
        check_project(&backend, &project)?;
        let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        crate::recovery::save(&dir, &project)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn recover_project(app: tauri::AppHandle) -> Result<Option<Project>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        let Some(mut p) = crate::recovery::load(&dir)? else {
            return Ok(None);
        };
        for m in &mut p.media {
            if m.kind.as_deref() == Some("gap") {
                continue;
            }
            let actual = approve(&app, &app.state::<Backend>(), Path::new(&m.path))?;
            m.preview_path = actual.preview_path;
            m.codec = actual.codec;
        }
        Ok(Some(p))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn export_video(
    app: tauri::AppHandle,
    project: Project,
    resolution: String,
    assets: Option<Vec<crate::annotations::OverlayAsset>>,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_project(&app.state::<Backend>(), &project)?;
        let backend = app.state::<Backend>();
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut active = lock(&backend.export)?;
            if active.is_some() {
                return Err("書き出し中です".into());
            }
            *active = Some(cancel.clone());
        }
        let Some(path) = rfd::FileDialog::new()
            .set_title("MP4を書き出す（新しい名前）")
            .add_filter("MP4", &["mp4"])
            .set_file_name("手順動画.mp4")
            .save_file()
        else {
            *lock(&backend.export)? = None;
            return Ok(false);
        };
        let result = media::export_with_overlays(
            &project,
            &path,
            &resolution,
            cancel,
            |progress| {
                let _ = app.emit(
                    "export-progress",
                    ExportEvent {
                        progress,
                        done: false,
                        error: None,
                    },
                );
            },
            &assets.unwrap_or_default(),
        );
        if result.is_ok() {
            *lock(&backend.last_output)? = Some(path);
        }
        *lock(&backend.export)? = None;
        let _ = app.emit(
            "export-progress",
            ExportEvent {
                progress: if result.is_ok() { 1.0 } else { 0.0 },
                done: true,
                error: result.clone().err(),
            },
        );
        result.map(|_| true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn cancel_export(backend: State<Backend>) -> Result<(), String> {
    if let Some(cancel) = lock(&backend.export)?.as_ref() {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}
#[tauri::command]
fn open_output_folder(backend: State<Backend>) -> Result<(), String> {
    let path = lock(&backend.last_output)?
        .clone()
        .ok_or("書き出した動画がありません")?;
    media::tool("explorer.exe")
        .arg(path.parent().ok_or("フォルダーが不明です")?)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
unsafe extern "system" fn monitor_callback(h: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> i32 {
    let list = &mut *(data as *mut Vec<Target>);
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..std::mem::zeroed()
    };
    if GetMonitorInfoW(h, &mut info) != 0 {
        let r = info.rcMonitor;
        list.push(Target {
            id: format!("monitor-{}", list.len()),
            name: format!(
                "モニター {}（{}×{}）",
                list.len() + 1,
                r.right - r.left,
                r.bottom - r.top
            ),
            kind: "monitor".into(),
            x: r.left,
            y: r.top,
            width: r.right - r.left,
            height: r.bottom - r.top,
        });
    }
    1
}
unsafe extern "system" fn window_callback(h: HWND, data: LPARAM) -> i32 {
    if IsWindowVisible(h) == 0 || IsIconic(h) != 0 {
        return 1;
    }
    let length = GetWindowTextLengthW(h);
    if length <= 0 {
        return 1;
    }
    let mut title = vec![0u16; length as usize + 1];
    let n = GetWindowTextW(h, title.as_mut_ptr(), title.len() as i32);
    let name = String::from_utf16_lossy(&title[..n as usize]);
    if name.contains("Operation Video Studio") {
        return 1;
    }
    let mut r = std::mem::zeroed();
    if GetWindowRect(h, &mut r) != 0 && r.right > r.left && r.bottom > r.top {
        let mut process_id = 0;
        GetWindowThreadProcessId(h, &mut process_id);
        if process_id == 0 {
            return 1;
        }
        (&mut *(data as *mut Vec<Target>)).push(Target {
            id: format!("window-{}-{}", h as usize, process_id),
            name,
            kind: "window".into(),
            x: r.left,
            y: r.top,
            width: r.right - r.left,
            height: r.bottom - r.top,
        });
    }
    1
}
#[tauri::command]
fn capture_targets(backend: State<Backend>) -> Result<Vec<Target>, String> {
    let mut list = Vec::new();
    unsafe {
        list.push(Target {
            id: "desktop".into(),
            name: "デスクトップ全体".into(),
            kind: "desktop".into(),
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        });
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(monitor_callback),
            &mut list as *mut _ as LPARAM,
        );
        EnumWindows(Some(window_callback), &mut list as *mut _ as LPARAM);
    }
    *lock(&backend.targets)? = list.clone();
    Ok(list)
}
fn exclude(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    // WDA_EXCLUDEFROMCAPTURE, Windows 10 2004+.
    if unsafe { SetWindowDisplayAffinity(hwnd.0 as HWND, 0x11) } == 0 {
        return Err("録画ツールバーを映像から除外できません。Windows 10 2004以降が必要です".into());
    }
    Ok(())
}
fn hide_outline(app: &tauri::AppHandle) -> Result<(), String> {
    let backend = app.state::<Backend>();
    let _transition = lock(&backend.outline_transition)?;
    backend.outline_ready.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("capture-outline") {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
async fn hide_capture_outline(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || hide_outline(&app))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn show_capture_outline(app: tauri::AppHandle, target_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backend = app.state::<Backend>();
        let _transition = lock(&backend.outline_transition)?;
        if backend.recording_transition.busy() || lock(&backend.recording)?.is_some() {
            return Ok(());
        }
        let mut target = if target_id == "region" {
            lock(&backend.region)?.clone()
        } else {
            lock(&backend.targets)?
                .iter()
                .find(|t| t.id == target_id)
                .cloned()
        }
        .ok_or("対象を再選択してください")?;
        if target.kind == "window" {
            if let Err(error) = window_capture_input(&target) {
                backend.outline_ready.store(false, Ordering::SeqCst);
                if let Some(window) = app.get_webview_window("capture-outline") {
                    let _ = window.destroy();
                }
                return Err(error);
            }
            let identity = WindowCapture::from_target_id(&target.id)?;
            let hwnd = identity.handle as HWND;
            let mut rect = unsafe { std::mem::zeroed() };
            let mut point = POINT { x: 0, y: 0 };
            if unsafe { GetClientRect(hwnd, &mut rect) } == 0
                || unsafe { ClientToScreen(hwnd, &mut point) } == 0
            {
                return Err("対象の位置を取得できません".into());
            }
            target.x = point.x;
            target.y = point.y;
            target.width = rect.right - rect.left;
            target.height = rect.bottom - rect.top;
        }
        if target.width <= 0 || target.height <= 0 {
            return Err("対象範囲が不正です".into());
        }
        let window = match app.get_webview_window("capture-outline") {
            Some(window) => window,
            None => {
                backend.outline_ready.store(false, Ordering::SeqCst);
                tauri::WebviewWindowBuilder::new(
                    &app,
                    "capture-outline",
                    tauri::WebviewUrl::App("index.html#capture-outline".into()),
                )
                .title("Operation Video Studio 録画対象確認")
                .visible(false)
                .focused(false)
                .focusable(false)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .resizable(false)
                .build()
                .map_err(|e| e.to_string())?
            }
        };
        let result = (|| -> Result<(), String> {
            window
                .set_position(tauri::PhysicalPosition::new(target.x, target.y))
                .map_err(|e| e.to_string())?;
            window
                .set_size(tauri::PhysicalSize::new(
                    target.width as u32,
                    target.height as u32,
                ))
                .map_err(|e| e.to_string())?;
            window
                .set_ignore_cursor_events(true)
                .map_err(|e| e.to_string())?;
            exclude(&window)?;
            if backend.outline_ready.load(Ordering::SeqCst) {
                window.show().map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        if result.is_err() {
            backend.outline_ready.store(false, Ordering::SeqCst);
            let _ = window.destroy();
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn capture_outline_ready(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if window.label() != "capture-outline" {
        return Err("確認枠の画面から操作してください".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let backend = app.state::<Backend>();
        let _transition = lock(&backend.outline_transition)?;
        let Some(current) = app.get_webview_window("capture-outline") else {
            return Ok(());
        };
        if current.hwnd().map_err(|e| e.to_string())?.0
            != window.hwnd().map_err(|e| e.to_string())?.0
        {
            return Ok(());
        }
        if backend.recording_transition.busy() || lock(&backend.recording)?.is_some() {
            return Ok(());
        }
        backend.outline_ready.store(true, Ordering::SeqCst);
        window.show().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn select_region(app: tauri::AppHandle) -> Result<(), String> {
    // WebView2 creation must not run in a synchronous IPC command on Windows:
    // https://github.com/tauri-apps/wry/issues/583
    tauri::async_runtime::spawn_blocking(move || {
        hide_outline(&app)?;
        if let Some(window) = app.get_webview_window("region") {
            return window.set_focus().map_err(|e| e.to_string());
        }
        let (x, y, w, h) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        if w <= 0 || h <= 0 {
            return Err("デスクトップの領域を取得できません".into());
        }
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "region",
            tauri::WebviewUrl::App(format!("index.html#region?x={x}&y={y}").into()),
        )
        .title("Operation Video Studio 領域選択")
        .visible(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .build()
        .map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            window
                .set_position(tauri::PhysicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
            window
                .set_size(tauri::PhysicalSize::new(w as u32, h as u32))
                .map_err(|e| e.to_string())?;
            exclude(&window)?;
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            Ok(())
        })();
        if result.is_err() {
            let _ = window.destroy();
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn complete_region(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    if window.label() != "region" {
        return Err("領域選択画面から操作してください".into());
    }
    let (left, top, w, h) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    if width < 16
        || height < 16
        || x < left
        || y < top
        || x.saturating_add(width) > left + w
        || y.saturating_add(height) > top + h
    {
        return Err("16ピクセル以上の範囲を画面内で選択してください".into());
    }
    let target = Target {
        id: "region".into(),
        name: format!("選択領域（{width}×{height}）"),
        kind: "region".into(),
        x,
        y,
        width,
        height,
    };
    *lock(&app.state::<Backend>().region)? = Some(target.clone());
    app.emit_to("main", "region-selected", target)
        .map_err(|e| e.to_string())?;
    window.close().map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn close_region(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "region" {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn window_capture_input(target: &Target) -> Result<String, String> {
    let identity = WindowCapture::from_target_id(&target.id)?;
    let hwnd = identity.handle as HWND;
    unsafe {
        if IsWindow(hwnd) == 0 {
            return Err(
                "録画対象のウィンドウが閉じられています。録画対象を再選択してください".into(),
            );
        }
        let mut process_id = 0;
        GetWindowThreadProcessId(hwnd, &mut process_id);
        if process_id != identity.process_id {
            return Err(
                "録画対象が別のウィンドウに変わりました。録画対象を再選択してください".into(),
            );
        }
        if IsIconic(hwnd) != 0 {
            return Err("録画対象が最小化されています。対象ウィンドウを元に戻してから開始・再開してください".into());
        }
        let mut rect = std::mem::zeroed();
        if GetClientRect(hwnd, &mut rect) == 0 || rect.right <= rect.left || rect.bottom <= rect.top
        {
            return Err(
                "録画対象の表示領域を取得できません。ウィンドウを表示してから再選択してください"
                    .into(),
            );
        }
    }
    Ok(identity.ffmpeg_input())
}
fn start_segment(recording: &mut Recording) -> Result<(), String> {
    let path = recording
        .dir
        .join(format!("segment-{}.mp4", recording.segments.len()));
    let log = fs::File::create(recording.dir.join("recording.log")).map_err(|e| e.to_string())?;
    let t = &recording.options.target;
    let mut cmd = media::tool("ffmpeg");
    cmd.args([
        "-hide_banner",
        "-y",
        "-f",
        "gdigrab",
        "-framerate",
        "30",
        "-draw_mouse",
        if recording.options.cursor { "1" } else { "0" },
    ]);
    if t.kind == "window" {
        // Titles can change when a document opens/closes (e.g. SOLIDWORKS).
        // Use the enumerated HWND and validate its owning process at each segment.
        cmd.arg("-i").arg(window_capture_input(t)?);
    } else {
        cmd.args([
            "-offset_x",
            &t.x.to_string(),
            "-offset_y",
            &t.y.to_string(),
            "-video_size",
            &format!("{}x{}", t.width, t.height),
            "-i",
            "desktop",
        ]);
    }
    cmd.args([
        "-vf",
        &format!("scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2,setsar=1", t.width / 2 * 2, t.height / 2 * 2, t.width / 2 * 2, t.height / 2 * 2),
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        if recording.options.quality == "high" {
            "18"
        } else {
            "23"
        },
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "2",
        "-movflags",
        "+faststart",
    ])
    .arg(&path)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(log);
    cmd.args(["-progress", "pipe:1", "-stats_period", "0.1"]);
    let audio = crate::audio::AudioRecording::start(
        &recording.dir,
        recording.segments.len(),
        recording.options.microphone,
        recording.options.system_audio,
    )?;
    let epoch = crate::audio::timestamp();
    audio.epoch.store(epoch, Ordering::SeqCst);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("録画を開始できません。FFmpegがPATHにあるか確認してください: {e}"))?;
    recording.audio_epoch = epoch;
    recording.first_video_epoch = Arc::new(AtomicU64::new(0));
    let first = recording.first_video_epoch.clone();
    if let Some(output) = child.stdout.take() {
        recording.progress_reader = Some(std::thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if let Some(us) = line
                    .strip_prefix("out_time_us=")
                    .and_then(|s| s.parse::<u64>().ok())
                {
                    if first.load(Ordering::SeqCst) == 0 {
                        first.store(
                            crate::audio::timestamp().saturating_sub(us.saturating_mul(10)),
                            Ordering::SeqCst,
                        );
                    }
                }
            }
        }));
    }
    recording.audio = Some(audio);
    recording.child = Some(child);
    recording.segments.push(path);
    recording.started = Some(Instant::now());
    if recording.options.highlight_clicks {
        let target = recording.options.target.clone();
        let w = target.width / 2 * 2;
        let h = target.height / 2 * 2;
        let path = recording
            .dir
            .join(format!("clicks-{}.ndjson", recording.segments.len() - 1));
        let capture = crate::clicks::Recorder::start(
            path.clone(),
            recording.started.unwrap(),
            recording.elapsed,
            move || {
                if target.kind == "window" {
                    let identity = WindowCapture::from_target_id(&target.id).ok()?;
                    let hwnd = identity.handle as HWND;
                    let mut rect = unsafe { std::mem::zeroed() };
                    let mut point = POINT { x: 0, y: 0 };
                    if unsafe { GetClientRect(hwnd, &mut rect) } == 0
                        || unsafe { ClientToScreen(hwnd, &mut point) } == 0
                    {
                        return None;
                    }
                    Some((
                        point.x,
                        point.y,
                        rect.right - rect.left,
                        rect.bottom - rect.top,
                    ))
                } else {
                    Some((target.x, target.y, target.width, target.height))
                }
            },
            w,
            h,
        );
        let capture = match capture {
            Ok(capture) => capture,
            Err(error) => {
                if let Some(mut child) = recording.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                recording.audio.take();
                recording.started = None;
                return Err(error);
            }
        };

        recording.click_files.push(path);
        recording.click_recorder = Some(capture);
    }

    Ok(())
}
fn stop_segment(r: &mut Recording) -> Result<(), String> {
    if r.child.is_none() {
        return Ok(());
    }

    let prior_elapsed = r.elapsed;
    let clicks_result = if let Some(mut clicks) = r.click_recorder.take() {
        clicks.stop()
    } else {
        Ok(())
    };
    let audio_result = if let Some(mut audio) = r.audio.take() {
        audio.stop()
    } else {
        Ok(())
    };

    if let Some(start) = r.started.take() {
        r.elapsed += start.elapsed().as_secs_f64();
    }
    if let Some(mut child) = r.child.take() {
        if let Some(mut input) = child.stdin.take() {
            let _ = input.write_all(b"q\n");
        }
        // Bounded wait: a stuck encoder must not hang the application forever.
        let deadline = Instant::now() + std::time::Duration::from_secs(20);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return Err(format!("録画に失敗しました。ウィンドウの最小化・対象の終了・空き容量を確認してください。\n{}",media::log_tail(&r.dir.join("recording.log"))));
                    }
                    break;
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(50))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("録画停止がタイムアウトしました。録画フォルダーに回復可能なセグメントが残っています".into());
                }
            }
        }
    }
    if let Some(reader) = r.progress_reader.take() {
        let _ = reader.join();
    }
    clicks_result?;
    audio_result?;
    let start_delay = r
        .first_video_epoch
        .load(Ordering::SeqCst)
        .saturating_sub(r.audio_epoch) as f64
        / 10_000_000.0;
    let start_delay = if r.first_video_epoch.load(Ordering::SeqCst) == 0 {
        0.0
    } else {
        start_delay
    };
    if let Some(path) = r.click_files.last() {
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let mut corrected = String::new();
        for line in text.lines() {
            let mut click: crate::clicks::Click =
                serde_json::from_str(line).map_err(|e| e.to_string())?;
            click.time -= start_delay;
            if click.time >= prior_elapsed {
                corrected.push_str(&serde_json::to_string(&click).map_err(|e| e.to_string())?);
                corrected.push('\n');
            }
        }
        fs::write(path, corrected).map_err(|e| e.to_string())?;
    }

    if let Some(path) = r.segments.last() {
        r.elapsed = prior_elapsed + media::probe(path)?.duration;
    }

    if r.options.microphone || r.options.system_audio {
        let index = r
            .segments
            .len()
            .checked_sub(1)
            .ok_or("録画セグメントがありません")?;
        let source = &r.segments[index];
        let seconds = media::probe(source)?.duration;
        let mut cmd = media::tool("ffmpeg");
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i"])
            .arg(source);
        let mut inputs = 0;
        for (enabled, label) in [
            (r.options.microphone, "mic"),
            (r.options.system_audio, "system"),
        ] {
            if enabled {
                cmd.args(["-ss", &start_delay.to_string(), "-i"])
                    .arg(r.dir.join(format!("segment-{index}-{label}.wav")));
                inputs += 1;
            }
        }
        let filter = if inputs == 2 {
            "[1:a][2:a]amix=inputs=2:duration=longest:normalize=0,aresample=async=1:first_pts=0,apad[a]"
        } else {
            "[1:a]aresample=async=1:first_pts=0,apad[a]"
        };
        let output = r.dir.join(format!("segment-{index}-audio.mp4"));
        let result = cmd
            .args([
                "-filter_complex",
                filter,
                "-map",
                "0:v:0",
                "-map",
                "[a]",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-t",
                &seconds.to_string(),
            ])
            .arg(&output)
            .output()
            .map_err(|e| e.to_string())?;
        if !result.status.success() {
            return Err(format!(
                "音声の結合に失敗しました: {}",
                String::from_utf8_lossy(&result.stderr)
            ));
        }
        r.segments[index] = output;
    }
    Ok(())
}
#[tauri::command]
async fn start_recording(app: tauri::AppHandle, options: RecordOptions) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backend = app.state::<Backend>();
        let _transition = backend.recording_transition.enter()?;
        hide_outline(&app)?;
        if lock(&backend.recording)?.is_some() {
            return Err("録画中です".into());
        }
        media::check_tools(true)?;
        let t = &options.target;
        let targets = lock(&backend.targets)?;
        let trusted = if t.kind == "region" {
            lock(&backend.region)?.clone()
        } else {
            targets.iter().find(|v| v.id == t.id).cloned()
        }
        .ok_or("録画対象を再選択してください")?;
        if trusted.width < 16 || trusted.height < 16 {
            return Err("録画対象が小さすぎます".into());
        }
        if trusted.kind == "window" {
            window_capture_input(&trusted)?;
        }
        drop(targets);
        let folder = match crate::recording_storage::load_folder(&recording_folder_settings(&app)?)?
        {
            Some(folder) => folder,
            None => match choose_recording_directory(&app)? {
                Some(folder) => folder,
                None => return Ok(false),
            },
        };
        let dir = crate::recording_storage::reserve_recording(&folder)?;
        let mut r = Recording {
            options: RecordOptions {
                target: trusted,
                ..options
            },
            dir,
            segments: vec![],
            child: None,
            elapsed: 0.0,
            started: None,
            audio: None,
            audio_epoch: 0,
            first_video_epoch: Arc::new(AtomicU64::new(0)),
            progress_reader: None,
            click_recorder: None,
            click_files: vec![],
        };
        let toolbar = tauri::WebviewWindowBuilder::new(
            &app,
            "recording",
            tauri::WebviewUrl::App("index.html#recording".into()),
        )
        .title("Operation Video Studio 録画中")
        .inner_size(460.0, 100.0)
        .always_on_top(true)
        .resizable(false)
        .build()
        .map_err(|e| e.to_string())?;
        if let Err(e) = exclude(&toolbar) {
            let _ = toolbar.destroy();
            return Err(e);
        }
        // The countdown is after destination selection and before the native capture process.
        for n in (1..=3).rev() {
            let _ = app.emit("record-countdown", n);
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.minimize();
        }
        if let Err(e) = start_segment(&mut r) {
            let _ = toolbar.destroy();
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.unminimize();
            }
            return Err(e);
        }
        *lock(&backend.recording)? = Some(r);
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn record_status(app: tauri::AppHandle) -> Result<RecordStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let backend = app.state::<Backend>();
    let mut guard = lock(&backend.recording)?;
    if let Some(r) = guard.as_mut() {
        if let Some(audio)=&r.audio {audio.health()?;}
        if let Some(child) = r.child.as_mut() {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                return Err(format!("録画プロセスが終了しました（{status}）。停止して録画ファイルを確認してください。\n{}",media::log_tail(&r.dir.join("recording.log"))));
            }
        }
        Ok(RecordStatus {
            active: true,
            paused: r.child.is_none(),
            seconds: r.elapsed + r.started.map(|i| i.elapsed().as_secs_f64()).unwrap_or(0.0),
        })
    } else {
        Ok(RecordStatus {
            active: false,
            paused: false,
            seconds: 0.0,
        })
    }
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn pause_recording(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backend = app.state::<Backend>();
        let _transition = backend.recording_transition.enter()?;
        let mut active = lock(&backend.recording)?;
        stop_segment(active.as_mut().ok_or("録画していません")?)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn resume_recording(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backend = app.state::<Backend>();
        let _transition = backend.recording_transition.enter()?;
        let mut active = lock(&backend.recording)?;
        let r = active.as_mut().ok_or("録画していません")?;
        if r.child.is_none() {
            start_segment(r)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn stop_recording(app: tauri::AppHandle) -> Result<Media, String> {
    let notify = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let backend = app.state::<Backend>();
        let _transition = backend.recording_transition.enter()?;
        let mut r = lock(&backend.recording)?.take().ok_or("録画していません")?;
        let stopped = stop_segment(&mut r);
        if let Some(toolbar) = app.get_webview_window("recording") {
            let _ = toolbar.destroy();
        }
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.set_focus();
        }
        let _ = app.emit_to("main", "recording-stopped", ());
        stopped?;
        let mut p = Project {
            audio: vec![],
            clicks: vec![],
            annotations: vec![],
            version: 1,
            media: vec![],
            clips: vec![],
        };
        for path in &r.segments {
            let m = media::probe(path)?;
            p.clips.push(media::Clip {
                muted: false,
                gain: None,
                name: None,
                id: uuid::Uuid::new_v4().to_string(),
                media_id: m.id.clone(),
                start: 0.0,
                end: m.duration,
            });
            p.media.push(m);
        }
        let name = r
            .dir
            .file_name()
            .ok_or("録画名が不明です")?
            .to_string_lossy();
        let path = r.dir.join(format!("{name}.mp4"));
        // Stream-copy the matching native recording segments; avoid another lossy encode.
        let list = r
            .segments
            .iter()
            .map(|path| {
                format!(
                    "file '{}'\n",
                    path.file_name().unwrap_or_default().to_string_lossy()
                )
            })
            .collect::<String>();
        fs::write(r.dir.join("segments.txt"), list).map_err(|e| e.to_string())?;
        let output = media::tool("ffmpeg")
            .args([
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-n",
                "-f",
                "concat",
                "-safe",
                "1",
                "-i",
            ])
            .arg(r.dir.join("segments.txt"))
            .args(["-c", "copy", "-movflags", "+faststart"])
            .arg(&path)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "録画の連結に失敗しました。セグメントは保存先に残っています。\n{}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let m = approve(&app, &backend, &path)?;
        #[derive(Serialize, Clone)]
        struct Finished<'a> {
            #[serde(flatten)]
            media: &'a Media,
            clicks: Vec<crate::clicks::Click>,
        }
        let mut clicks = Vec::new();
        for file in &r.click_files {
            let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
            for line in text.lines() {
                if clicks.len() >= 10000 {
                    return Err(
                        "クリック記録が10000件を超えました。録画動画と記録は保存先に残っています"
                            .into(),
                    );
                }
                let mut click: crate::clicks::Click =
                    serde_json::from_str(line).map_err(|e| e.to_string())?;
                if click.time < m.duration {
                    click.media_id = m.id.clone();
                    clicks.push(click);
                }
            }
        }
        app.emit_to("main", "recording-finished", Finished { media: &m, clicks })
            .map_err(|e| e.to_string())?;
        Ok(m)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Err(error) = &result {
        let _ = notify.emit_to("main", "backend-error", error);
    }
    result
}
pub fn run() {
    tauri::Builder::default()
        .manage(Backend::default())
        .setup(|app| {
            if let Ok(dir) = app.path().app_local_data_dir() {
                if let Ok(bytes) = fs::read(dir.join("ffmpeg-directory.json")) {
                    if let Ok(directory) = serde_json::from_slice::<Option<PathBuf>>(&bytes) {
                        let _ = media::set_tool_directory(directory);
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(outline) = window.app_handle().get_webview_window("capture-outline") {
                    let _ = outline.destroy();
                }
            }
            if window.label() == "recording" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let backend = window.state::<Backend>();
                    if backend.recording_transition.busy()
                        || backend
                            .recording
                            .try_lock()
                            .map(|g| g.is_some())
                            .unwrap_or(true)
                    {
                        api.prevent_close();
                    }
                }
            }
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let backend = window.state::<Backend>();
                    let recording = backend
                        .recording
                        .try_lock()
                        .map(|g| g.is_some())
                        .unwrap_or(true);
                    let exporting = backend
                        .export
                        .try_lock()
                        .map(|g| g.is_some())
                        .unwrap_or(true);
                    if recording || exporting || backend.recording_transition.busy() {
                        api.prevent_close();
                        let _ = window.emit(
                            "backend-error",
                            "録画または書き出しを停止してから終了してください。",
                        );
                    }
                }
                if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) =
                    event
                {
                    let app = window.app_handle().clone();
                    let paths = paths.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let backend = app.state::<Backend>();
                        let allowed = paths.iter().filter(|p| {
                            p.extension()
                                .and_then(|e| e.to_str())
                                .map(|e| {
                                    matches!(
                                        e.to_lowercase().as_str(),
                                        "mp4" | "mov" | "mkv" | "avi" | "webm" | "m4v"
                                    )
                                })
                                .unwrap_or(false)
                        });
                        let result: Result<Vec<Media>, String> =
                            allowed.map(|p| approve(&app, &backend, p)).collect();
                        match result {
                            Ok(media) => {
                                let _ = app.emit_to("main", "media-dropped", media);
                            }
                            Err(error) => {
                                let _ = app.emit_to("main", "backend-error", error);
                            }
                        }
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            show_capture_outline,
            hide_capture_outline,
            capture_outline_ready,
            recording_folder,
            choose_recording_folder,
            recording_tools,
            choose_ffmpeg_folder,
            import_videos,
            save_project,
            open_project,
            autosave,
            recover_project,
            export_video,
            cancel_export,
            open_output_folder,
            capture_targets,
            select_region,
            complete_region,
            close_region,
            start_recording,
            record_status,
            pause_recording,
            resume_recording,
            stop_recording
        ])
        .build(tauri::generate_context!())
        .expect("アプリを初期化できません")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let backend = app.state::<Backend>();
                if let Ok(mut guard) = backend.recording.lock() {
                    if let Some(r) = guard.as_mut() {
                        let _ = stop_segment(r);
                    }
                }
                if let Ok(guard) = backend.export.lock() {
                    if let Some(c) = guard.as_ref() {
                        c.store(true, Ordering::SeqCst);
                    }
                };
            }
        });
}
