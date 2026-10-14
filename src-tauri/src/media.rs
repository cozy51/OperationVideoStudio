use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::Duration,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub id: String,
    pub path: String,
    pub name: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub media_id: String,
    pub start: f64,
    pub end: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    pub version: u32,
    pub media: Vec<Media>,
    pub clips: Vec<Clip>,
}

static TOOL_DIRECTORY: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
fn tool_directory() -> &'static Mutex<Option<PathBuf>> {
    TOOL_DIRECTORY.get_or_init(|| Mutex::new(None))
}
pub fn configured_tool_directory() -> Option<PathBuf> {
    tool_directory().lock().ok().and_then(|p| p.clone())
}
fn tool_filename(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    }
}
pub fn set_tool_directory(directory: Option<PathBuf>) -> Result<(), String> {
    let directory = directory
        .map(|p| fs::canonicalize(p).map_err(|e| format!("FFmpegフォルダーを開けません: {e}")))
        .transpose()?;
    if let Some(path) = &directory {
        if !path.is_dir()
            || !["ffmpeg", "ffprobe"]
                .iter()
                .all(|name| path.join(tool_filename(name)).is_file())
        {
            return Err(
                "ffmpeg.exe と ffprobe.exe の両方があるフォルダー（通常は bin）を選択してください"
                    .into(),
            );
        }
    }
    *tool_directory()
        .lock()
        .map_err(|_| "FFmpeg設定を変更できません")? = directory;
    Ok(())
}
pub fn tool(name: &str) -> Command {
    let executable = if matches!(name, "ffmpeg" | "ffprobe") {
        configured_tool_directory()
            .map(|p| p.join(tool_filename(name)))
            .unwrap_or_else(|| PathBuf::from(name))
    } else {
        PathBuf::from(name)
    };
    #[allow(unused_mut)]
    let mut cmd = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}
pub fn check_tools(require_capture: bool) -> Result<String, String> {
    let version=tool("ffmpeg").arg("-version").output().map_err(|e|format!("FFmpegが見つかりません。「FFmpegのフォルダーを設定」で ffmpeg.exe と ffprobe.exe のある bin フォルダーを選択してください。PATHに導入した場合はアプリを再起動してください。\n{e}"))?;
    let probe = tool("ffprobe").arg("-version").output().map_err(|e| {
        format!("FFprobeが見つかりません。ffmpeg.exe と ffprobe.exe の両方が必要です。\n{e}")
    })?;
    if !version.status.success() || !probe.status.success() {
        return Err("FFmpegまたはFFprobeを正常に実行できません。信頼する配布元のWindowsビルドを選択してください".into());
    }
    let encoders = tool("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .map_err(|e| e.to_string())?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&encoders.stdout),
        String::from_utf8_lossy(&encoders.stderr)
    );
    if !encoders.status.success()
        || !text
            .lines()
            .any(|line| line.split_whitespace().any(|word| word == "libx264"))
        || !text
            .lines()
            .any(|line| line.split_whitespace().any(|word| word == "aac"))
    {
        return Err("このFFmpegは必要なH.264 (libx264) / AACエンコーダーに対応していません".into());
    }
    if require_capture {
        let devices = tool("ffmpeg")
            .args(["-hide_banner", "-devices"])
            .output()
            .map_err(|e| e.to_string())?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&devices.stdout),
            String::from_utf8_lossy(&devices.stderr)
        );
        if !devices.status.success()
            || !text
                .lines()
                .any(|line| line.split_whitespace().any(|word| word == "gdigrab"))
        {
            return Err("このFFmpegはWindows録画 (gdigrab) に対応していません。Windows用ビルドを設定してください".into());
        }
    }
    Ok(String::from_utf8_lossy(&version.stdout)
        .lines()
        .next()
        .unwrap_or("FFmpeg / FFprobe 使用可能")
        .to_string())
}

pub fn probe(path: &Path) -> Result<Media, String> {
    let path = fs::canonicalize(path).map_err(|e| format!("動画を開けません: {e}"))?;
    let output = tool("ffprobe")
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            "mov,matroska,webm,avi",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ])
        .arg(&path)
        .output()
        .map_err(|e| {
            format!("FFprobeを実行できません。PATHにFFmpeg/FFprobeを設定してください: {e}")
        })?;
    if !output.status.success() {
        return Err(format!(
            "動画の解析に失敗しました: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let v: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let streams = v["streams"]
        .as_array()
        .ok_or("動画ストリームがありません")?;
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .ok_or("映像のないファイルは読み込めません")?;
    let duration = v["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .ok_or("動画の長さを取得できません")?;
    if !duration.is_finite() || duration <= 0.0 {
        return Err("動画の長さが不正です".into());
    }
    Ok(Media {
        id: uuid::Uuid::new_v4().to_string(),
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        duration,
        width: video["width"].as_u64().ok_or("映像の幅が不明です")? as u32,
        height: video["height"].as_u64().ok_or("映像の高さが不明です")? as u32,
        has_audio: streams.iter().any(|s| s["codec_type"] == "audio"),
    })
}
pub fn validate(project: &Project) -> Result<(), String> {
    if project.version != 1 || project.media.len() > 1000 || project.clips.len() > 10000 {
        return Err("プロジェクト形式または規模が非対応です".into());
    }
    let mut ids = std::collections::HashSet::new();
    for m in &project.media {
        if !ids.insert(&m.id)
            || m.path.is_empty()
            || !m.duration.is_finite()
            || m.duration <= 0.0
            || m.width == 0
            || m.height == 0
        {
            return Err("動画情報が不正です".into());
        }
    }
    let mut clips = std::collections::HashSet::new();
    for c in &project.clips {
        let m = project
            .media
            .iter()
            .find(|m| m.id == c.media_id)
            .ok_or("動画参照が見つかりません")?;
        if !clips.insert(&c.id)
            || !c.start.is_finite()
            || !c.end.is_finite()
            || c.start < 0.0
            || c.end <= c.start
            || c.end > m.duration + 0.05
        {
            return Err("クリップの時間範囲が不正です".into());
        }
    }
    Ok(())
}
pub fn log_tail(path: &Path) -> String {
    use std::io::{Seek, SeekFrom};
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(len.saturating_sub(6000)));
    let mut s = String::new();
    let _ = file.read_to_string(&mut s);
    s
}

fn run_ffmpeg(
    mut cmd: Command,
    cancel: &Arc<AtomicBool>,
    progress: &mut impl FnMut(f64),
    seconds: f64,
    base: f64,
    weight: f64,
    log: &Path,
) -> Result<(), String> {
    let stderr = fs::File::create(log).map_err(|e| e.to_string())?;
    let mut child = cmd
        .args(["-progress", "pipe:1", "-nostats"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(stderr)
        .spawn()
        .map_err(|e| format!("FFmpegを起動できません: {e}"))?;
    let stdout = child.stdout.take().ok_or("進捗出力を取得できません")?;
    let (tx, rx) = std::sync::mpsc::sync_channel(32);
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(time) = line
                .strip_prefix("out_time_us=")
                .and_then(|v| v.parse::<f64>().ok())
            {
                let _ = tx.try_send(time / 1_000_000.0);
            }
        }
    });
    let result = loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            break Err("書き出しをキャンセルしました".into());
        }
        while let Ok(time) = rx.try_recv() {
            progress(base + weight * (time / seconds).clamp(0.0, 1.0));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(format!("FFmpegの動画処理に失敗しました。空き容量・形式・エンコーダーを確認してください。\n{}", log_tail(log)))
                }
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(e.to_string());
            }
        }
    };
    let _ = reader.join();
    result
}

// Each clip is normalized separately: bounded command size, memory and open input count.
// Temporary output lives beside the destination, and is committed only after validation.
pub fn export(
    project: &Project,
    output: &Path,
    resolution: &str,
    cancel: Arc<AtomicBool>,
    mut progress: impl FnMut(f64),
) -> Result<(), String> {
    validate(project)?;
    if project.clips.is_empty() {
        return Err("書き出すクリップがありません".into());
    }
    if output.exists() {
        return Err("既存ファイルは上書きしません。新しい名前を指定してください".into());
    }
    let parent = output.parent().ok_or("出力先が不正です")?;
    if !parent.is_dir() {
        return Err("出力フォルダーが存在しません".into());
    }
    let first = project
        .media
        .iter()
        .find(|m| m.id == project.clips[0].media_id)
        .unwrap();
    let (width, height) = match resolution {
        "720p" => (1280, 720),
        "1080p" => (1920, 1080),
        "source" => (first.width / 2 * 2, first.height / 2 * 2),
        _ => return Err("解像度が不正です".into()),
    };
    if width == 0 || height == 0 {
        return Err("解像度が不正です".into());
    }
    let tmp = tempfile::Builder::new()
        .prefix(".ovs-export-")
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    let total: f64 = project.clips.iter().map(|c| c.end - c.start).sum();
    let mut done = 0.0;
    for (i, c) in project.clips.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err("書き出しをキャンセルしました".into());
        }
        let m = project.media.iter().find(|m| m.id == c.media_id).unwrap();
        let actual = probe(Path::new(&m.path))?;
        if c.end > actual.duration + 0.05 {
            return Err("元動画の長さが変更されています。再読み込みしてください".into());
        }
        let length = c.end - c.start;
        let mut cmd = tool("ffmpeg");
        cmd.args([
            "-hide_banner",
            "-y",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            "mov,matroska,webm,avi",
            "-ss",
            &c.start.to_string(),
        ])
        .arg("-i")
        .arg(&m.path);
        if !actual.has_audio {
            cmd.args(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]);
        }
        cmd.args(["-t", &length.to_string(), "-map","0:v:0","-map", if actual.has_audio {"0:a:0"} else {"1:a:0"},
            "-vf", &format!("scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,setpts=PTS-STARTPTS"),
            "-af","aresample=48000,asetpts=PTS-STARTPTS,apad", "-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-threads","2","-c:a","aac","-b:a","192k","-ar","48000","-ac","2"])
            .arg(tmp.path().join(format!("clip-{i}.mp4")));
        run_ffmpeg(
            cmd,
            &cancel,
            &mut progress,
            length,
            0.9 * done / total,
            0.9 * length / total,
            &tmp.path().join("ffmpeg.log"),
        )?;
        done += length;
    }
    let list = (0..project.clips.len())
        .map(|i| format!("file 'clip-{i}.mp4'\n"))
        .collect::<String>();
    fs::write(tmp.path().join("list.txt"), list).map_err(|e| e.to_string())?;
    let final_path = tmp.path().join("final.mp4");
    let mut cmd = tool("ffmpeg");
    cmd.args(["-hide_banner", "-y", "-f", "concat", "-safe", "1", "-i"])
        .arg(tmp.path().join("list.txt"))
        .args(["-c", "copy", "-movflags", "+faststart"])
        .arg(&final_path);
    run_ffmpeg(
        cmd,
        &cancel,
        &mut progress,
        total,
        0.9,
        0.1,
        &tmp.path().join("ffmpeg.log"),
    )?;
    let result = probe(&final_path)?;
    if (result.duration - total).abs() > 0.25 + project.clips.len() as f64 / 30.0 {
        return Err("出力の長さが予定と一致しません".into());
    }
    if cancel.load(Ordering::SeqCst) {
        return Err("書き出しをキャンセルしました".into());
    }
    // persist_noclobber uses a filesystem operation that refuses to replace an existing file.
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    std::io::copy(
        &mut fs::File::open(&final_path).map_err(|e| e.to_string())?,
        &mut staged,
    )
    .map_err(|e| e.to_string())?;
    staged.as_file().sync_all().map_err(|e| e.to_string())?;
    staged
        .persist_noclobber(output)
        .map_err(|e| format!("出力保存に失敗しました（上書きは行いません）: {e}"))?;
    progress(1.0);
    Ok(())
}
