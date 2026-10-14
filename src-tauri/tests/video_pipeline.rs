use ovs::media::{self, Clip, Project};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
fn generate(path: &Path, color: &str, size: &str, fps: &str, audio: bool, seconds: &str) {
    let mut cmd = media::tool("ffmpeg");
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        &format!("color=c={color}:s={size}:r={fps}"),
    ]);
    if audio {
        cmd.args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100"]);
    }
    cmd.args([
        "-t", seconds, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "2",
    ]);
    if audio {
        cmd.args(["-c:a", "aac"]);
    }
    assert!(cmd.arg(path).status().unwrap().success());
}
fn rgb(path: &Path, t: f64) -> Vec<u8> {
    let output = media::tool("ffmpeg")
        .args(["-v", "error", "-ss", &t.to_string(), "-i"])
        .arg(path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale=1:1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    output.stdout
}
#[test]
fn cuts_and_normalizes_different_sources_without_touching_originals() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("日本語 red.mp4");
    let b = tmp.path().join("blue.mp4");
    generate(&a, "red", "320x180", "24", true, "30");
    generate(&b, "blue", "240x320", "15", false, "4");
    let original = std::fs::read(&a).unwrap();
    let m1 = media::probe(&a).unwrap();
    let m2 = media::probe(&b).unwrap();
    let p = Project {
        version: 1,
        clips: vec![
            Clip {
                id: "a".into(),
                media_id: m1.id.clone(),
                start: 0.0,
                end: 10.0,
            },
            Clip {
                id: "b".into(),
                media_id: m1.id.clone(),
                start: 15.0,
                end: 30.0,
            },
            Clip {
                id: "c".into(),
                media_id: m2.id.clone(),
                start: 0.0,
                end: 2.0,
            },
        ],
        media: vec![m1, m2],
    };
    let out = tmp.path().join("完成.mp4");
    let mut last = 0.0;
    media::export(&p, &out, "720p", Arc::new(AtomicBool::new(false)), |v| {
        assert!(v >= last - 0.001);
        last = v;
    })
    .unwrap();
    let result = media::probe(&out).unwrap();
    assert!((result.duration - 27.0).abs() < 0.2);
    assert_eq!((result.width, result.height), (1280, 720));
    assert!(result.has_audio);
    assert_eq!(last, 1.0);
    let red = rgb(&out, 0.5);
    let blue = rgb(&out, 26.0);
    assert!(red[0] > red[2] + 100);
    assert!(blue[2] > blue[0] + 100);
    assert_eq!(std::fs::read(&a).unwrap(), original);
    let before = std::fs::read(&out).unwrap();
    assert!(media::export(&p, &out, "720p", Arc::new(AtomicBool::new(false)), |_| {}).is_err());
    assert_eq!(std::fs::read(&out).unwrap(), before);
    let detail = media::tool("ffprobe")
        .args(["-v", "error", "-show_streams", "-of", "json"])
        .arg(&out)
        .output()
        .unwrap();
    let detail: serde_json::Value = serde_json::from_slice(&detail.stdout).unwrap();
    let streams = detail["streams"].as_array().unwrap();
    assert_eq!(streams[0]["codec_name"], "h264");
    assert_eq!(streams[0]["r_frame_rate"], "30/1");
    assert_eq!(streams[1]["codec_name"], "aac");
    assert!(media::tool("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(&out)
        .args(["-f", "null", "-"])
        .status()
        .unwrap()
        .success());
}
#[test]
fn cancellation_removes_temporary_outputs() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source.mp4");
    generate(&source, "green", "320x180", "30", false, "4");
    let m = media::probe(&source).unwrap();
    let p = Project {
        version: 1,
        clips: vec![Clip {
            id: "a".into(),
            media_id: m.id.clone(),
            start: 0.0,
            end: 4.0,
        }],
        media: vec![m],
    };
    let out = tmp.path().join("cancelled.mp4");
    let cancel = Arc::new(AtomicBool::new(false));
    let trigger = cancel.clone();
    assert!(media::export(&p, &out, "1080p", cancel, move |_| {
        trigger.store(true, Ordering::SeqCst);
    })
    .is_err());
    assert!(!out.exists());
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
}
#[test]
fn rejects_invalid_ranges() {
    let p = Project {
        version: 1,
        media: vec![],
        clips: vec![Clip {
            id: "x".into(),
            media_id: "missing".into(),
            start: 0.0,
            end: 10.0,
        }],
    };
    assert!(media::validate(&p).is_err());
}

#[test]
fn rejects_playlists_disguised_as_video_files() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("playlist.mp4");
    std::fs::write(
        &path,
        "ffconcat version 1.0\nfile 'https://example.invalid/private.mp4'\n",
    )
    .unwrap();
    assert!(media::probe(&path).unwrap_err().contains("whitelist"));
}
