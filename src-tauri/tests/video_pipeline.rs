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
        audio: vec![],
        clicks: vec![],
        annotations: vec![],
        version: 1,
        clips: vec![
            Clip {
                muted: false,
                gain: None,
                name: None,
                id: "a".into(),
                media_id: m1.id.clone(),
                start: 0.0,
                end: 10.0,
            },
            Clip {
                muted: false,
                gain: None,
                name: None,
                id: "b".into(),
                media_id: m1.id.clone(),
                start: 15.0,
                end: 30.0,
            },
            Clip {
                muted: false,
                gain: None,
                name: None,
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
        audio: vec![],
        clicks: vec![],
        annotations: vec![],
        version: 1,
        clips: vec![Clip {
            muted: false,
            gain: None,
            name: None,
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
        audio: vec![],
        clicks: vec![],
        annotations: vec![],
        version: 1,
        media: vec![],
        clips: vec![Clip {
            muted: false,
            gain: None,
            name: None,
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

#[test]
fn verifies_installed_encoder_and_probe_before_recording() {
    assert!(media::check_tools(false).is_ok());
}
#[test]
fn rejects_incomplete_ffmpeg_folder_without_changing_configuration() {
    let folder = tempfile::tempdir().unwrap();
    let before = media::configured_tool_directory();
    assert!(media::set_tool_directory(Some(folder.path().to_owned())).is_err());
    assert_eq!(media::configured_tool_directory(), before);
}

#[test]
fn clip_display_names_roundtrip_and_old_projects_remain_readable() {
    let mut clip: Clip =
        serde_json::from_str(r#"{"id":"a","mediaId":"m","start":0,"end":4}"#).unwrap();
    assert!(clip.name.is_none());
    clip.name = Some("設定を確認".into());
    let restored: Clip = serde_json::from_str(&serde_json::to_string(&clip).unwrap()).unwrap();
    assert_eq!(restored.name.as_deref(), Some("設定を確認"));
    assert_eq!(restored.media_id, "m");
}

fn asset(
    id: &str,
    w: u32,
    h: u32,
    pixel: impl Fn(u32, u32) -> [u8; 4],
) -> ovs::annotations::OverlayAsset {
    use base64::Engine;
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        let mut data = Vec::new();
        for y in 0..h {
            for x in 0..w {
                data.extend(pixel(x, y));
            }
        }
        writer.write_image_data(&data).unwrap();
    }
    ovs::annotations::OverlayAsset {
        id: id.into(),
        png: base64::engine::general_purpose::STANDARD.encode(bytes),
    }
}
fn pixel_at(path: &Path, time: f64, x: u32, y: u32) -> Vec<u8> {
    let out = media::tool("ffmpeg")
        .args(["-v", "error", "-ss", &time.to_string(), "-i"])
        .arg(path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("format=rgb24,crop=1:1:{x}:{y}"),
            "-f",
            "rawvideo",
            "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(out.status.success());
    out.stdout
}
#[test]
fn burns_timed_shared_png_annotations_and_click_markers() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source.mp4");
    generate(&source, "black", "320x180", "30", false, "4");
    let m = media::probe(&source).unwrap();
    let annotation = ovs::annotations::Annotation {
        id: "comment".into(),
        kind: "text".into(),
        start: 1.0,
        end: 2.0,
        x: 0.1,
        y: 0.1,
        width: 0.3,
        height: 0.2,
        text: "ここをクリック".into(),
        color: "#ff0000".into(),
        background: "#ffffff".into(),
        background_opacity: 1.0,
        opacity: 1.0,
        line_width: 4.0,
        font_size: 36.0,
        font_family: "Yu Gothic UI".into(),
    };
    let p = Project {
        audio: vec![],
        version: 2,
        media: vec![m.clone()],
        clips: vec![Clip {
            muted: false,
            gain: None,
            id: "c".into(),
            media_id: m.id.clone(),
            start: 0.0,
            end: 4.0,
            name: None,
        }],
        annotations: vec![annotation],
        clicks: vec![ovs::clicks::Click {
            time: 2.5,
            x: 0.5,
            y: 0.5,
            media_id: m.id.clone(),
        }],
    };
    let assets = vec![
        asset("comment", 1280, 720, |x, y| {
            if x > 128 && x < 512 && y > 72 && y < 216 {
                [255, 0, 0, 255]
            } else {
                [0, 0, 0, 0]
            }
        }),
        asset("__click_marker", 43, 43, |_, _| [255, 128, 0, 255]),
    ];
    let output = tmp.path().join("commented.mp4");
    media::export_with_overlays(
        &p,
        &output,
        "720p",
        Arc::new(AtomicBool::new(false)),
        |_| {},
        &assets,
    )
    .unwrap();
    assert!(pixel_at(&output, 0.5, 200, 120)[0] < 20);
    assert!(pixel_at(&output, 1.5, 200, 120)[0] > 200);
    assert!(pixel_at(&output, 2.2, 200, 120)[0] < 20);
    assert!(pixel_at(&output, 2.6, 640, 360)[0] > 200);
    assert!(pixel_at(&output, 3.1, 640, 360)[0] < 20);
}
#[test]
fn outputs_black_gaps_and_mosaic_without_source_mutation() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("pattern.mp4");
    assert!(media::tool("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=320x180:r=30",
            "-t",
            "2",
            "-c:v",
            "libx264",
            "-threads",
            "2"
        ])
        .arg(&source)
        .status()
        .unwrap()
        .success());
    let m = media::probe(&source).unwrap();
    let before = std::fs::read(&source).unwrap();
    let gap = media::Media {
        preview_path: None,
        codec: None,
        kind: Some("gap".into()),
        id: "gap".into(),
        path: String::new(),
        name: "黒画面".into(),
        duration: 1.0,
        width: 1280,
        height: 720,
        has_audio: false,
    };
    let annotation = ovs::annotations::Annotation {
        id: "mask".into(),
        kind: "mosaic".into(),
        start: 0.5,
        end: 1.5,
        x: 0.1,
        y: 0.1,
        width: 0.3,
        height: 0.2,
        text: String::new(),
        color: "#ff0000".into(),
        background: "#ffffff".into(),
        background_opacity: 1.0,
        opacity: 1.0,
        line_width: 4.0,
        font_size: 36.0,
        font_family: "Yu Gothic UI".into(),
    };
    let p = Project {
        audio: vec![],
        version: 2,
        media: vec![m.clone(), gap],
        clips: vec![
            Clip {
                muted: false,
                gain: None,
                id: "c".into(),
                media_id: m.id,
                start: 0.0,
                end: 2.0,
                name: None,
            },
            Clip {
                muted: false,
                gain: None,
                id: "g".into(),
                media_id: "gap".into(),
                start: 0.0,
                end: 1.0,
                name: None,
            },
        ],
        annotations: vec![annotation],
        clicks: vec![],
    };
    let out = tmp.path().join("masked.mp4");
    media::export_with_overlays(
        &p,
        &out,
        "720p",
        Arc::new(AtomicBool::new(false)),
        |_| {},
        &[],
    )
    .unwrap();
    assert!((media::probe(&out).unwrap().duration - 3.0).abs() < 0.2);
    assert!(pixel_at(&out, 2.5, 640, 360).iter().all(|v| *v < 10));
    assert_eq!(std::fs::read(&source).unwrap(), before);
}

#[test]
fn builds_and_reuses_local_preview_proxy_for_mkv() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("素材.mkv");
    generate(&source, "green", "320x180", "24", true, "4");
    let original = std::fs::read(&source).unwrap();
    let cache = tmp.path().join("cache");
    let m = media::prepare_preview(&source, &cache).unwrap();
    let proxy = m.preview_path.clone().unwrap();
    assert_eq!(
        media::probe(Path::new(&proxy)).unwrap().codec.as_deref(),
        Some("h264")
    );
    let again = media::prepare_preview(&source, &cache).unwrap();
    assert_eq!(again.preview_path, m.preview_path);
    assert_eq!(std::fs::read(source).unwrap(), original);
}

#[test]
fn clip_mute_is_baked_into_export_audio() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("audio.mp4");
    generate(&source, "red", "320x180", "30", true, "4");
    let m = media::probe(&source).unwrap();
    let p = Project {
        audio: vec![],
        version: 2,
        media: vec![m.clone()],
        clips: vec![Clip {
            id: "c".into(),
            media_id: m.id,
            name: None,
            start: 0.0,
            end: 2.0,
            muted: true,
            gain: Some(0.5),
        }],
        annotations: vec![],
        clicks: vec![],
    };
    let out = tmp.path().join("muted.mp4");
    media::export(&p, &out, "720p", Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
    let decoded = media::tool("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(out)
        .args(["-vn", "-f", "s16le", "-ac", "1", "-ar", "48000", "pipe:1"])
        .output()
        .unwrap();
    assert!(decoded.status.success());
    assert!(!decoded.stdout.is_empty());
    assert!(decoded.stdout.iter().all(|b| *b == 0));
}
#[test]
fn annotation_images_are_required_and_existing_output_remains_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source.mp4");
    generate(&source, "black", "320x180", "30", false, "4");
    let m = media::probe(&source).unwrap();
    let annotation = ovs::annotations::Annotation {
        id: "text".into(),
        kind: "text".into(),
        start: 0.0,
        end: 1.0,
        x: 0.1,
        y: 0.1,
        width: 0.3,
        height: 0.2,
        text: "説明".into(),
        color: "#ff0000".into(),
        background: "#ffffff".into(),
        background_opacity: 0.8,
        opacity: 1.0,
        line_width: 4.0,
        font_size: 36.0,
        font_family: "Meiryo".into(),
    };
    let p = Project {
        audio: vec![],
        version: 2,
        media: vec![m.clone()],
        clips: vec![Clip {
            id: "c".into(),
            media_id: m.id,
            name: None,
            start: 0.0,
            end: 1.0,
            muted: false,
            gain: None,
        }],
        annotations: vec![annotation],
        clicks: vec![],
    };
    let out = tmp.path().join("missing.mp4");
    assert!(media::export(&p, &out, "720p", Arc::new(AtomicBool::new(false)), |_| {}).is_err());
    assert!(!out.exists());
}

#[test]
fn independent_audio_is_delayed_and_progress_never_moves_backwards() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("voice.mp4");
    generate(&source, "black", "320x180", "30", true, "4");
    let m = media::probe(&source).unwrap();
    let p = Project {
        version: 2,
        media: vec![m.clone()],
        clips: vec![Clip {
            id: "c".into(),
            media_id: m.id.clone(),
            name: None,
            start: 0.0,
            end: 3.0,
            muted: true,
            gain: None,
        }],
        audio: vec![media::AudioClip {
            id: "voice".into(),
            media_id: m.id,
            start: 0.0,
            end: 1.0,
            at: 1.0,
            gain: 0.5,
            muted: false,
        }],
        annotations: vec![],
        clicks: vec![],
    };
    let out = tmp.path().join("mixed.mp4");
    let mut progress = Vec::new();
    media::export(&p, &out, "720p", Arc::new(AtomicBool::new(false)), |v| {
        progress.push(v)
    })
    .unwrap();
    assert!(progress.windows(2).all(|w| w[1] >= w[0]));
    let decoded = media::tool("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(&out)
        .args(["-vn", "-f", "s16le", "-ac", "1", "-ar", "48000", "pipe:1"])
        .output()
        .unwrap();
    assert!(decoded.status.success());
    let samples: Vec<i16> = decoded
        .stdout
        .chunks_exact(2)
        .map(|v| i16::from_le_bytes([v[0], v[1]]))
        .collect();
    assert!(samples[0..24000].iter().all(|s| s.abs() < 10));
    assert!(samples[60000..84000].iter().any(|s| s.abs() > 100));
    assert!(samples[120000..132000].iter().all(|s| s.abs() < 10));
}
