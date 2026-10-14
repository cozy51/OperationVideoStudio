//! Native WASAPI microphone and render-loopback recording, streamed to WAV.
//! Shared QPC time anchors packets to the video segment; no full recording buffer.
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};
use windows::Win32::Media::Audio::IAudioCaptureClient;
use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
pub fn timestamp() -> u64 {
    unsafe {
        let (mut count, mut frequency) = (0, 0);
        QueryPerformanceCounter(&mut count);
        QueryPerformanceFrequency(&mut frequency);
        if frequency <= 0 {
            return 0;
        }
        ((count as u128 * 10_000_000) / frequency as u128) as u64
    }
}
struct Worker {
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<Result<(), String>>>,
}
pub struct AudioRecording {
    workers: Vec<Worker>,
    pub files: Vec<PathBuf>,
    pub epoch: Arc<AtomicU64>,
}
impl AudioRecording {
    pub fn start(dir: &Path, index: usize, microphone: bool, system: bool) -> Result<Self, String> {
        let mut session = Self {
            workers: vec![],
            files: vec![],
            epoch: Arc::new(AtomicU64::new(0)),
        };
        for (enabled, loopback, label) in [(microphone, false, "mic"), (system, true, "system")] {
            if !enabled {
                continue;
            }
            let path = dir.join(format!("segment-{index}-{label}.wav"));
            let output = path.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopping = stop.clone();
            let epoch = session.epoch.clone();
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            let join = thread::spawn(move || {
                let result = capture(output, loopback, stopping, epoch, &tx);
                if let Err(error) = &result {
                    let _ = tx.try_send(Err(error.clone()));
                }
                result
            });
            session.workers.push(Worker {
                stop,
                join: Some(join),
            });
            session.files.push(path);
            match rx.recv_timeout(Duration::from_secs(10)) {
                Ok(Ok(())) => {}
                Ok(Err(e)) => return Err(format!("音声デバイスを開始できません（{label}）: {e}")),
                Err(e) => return Err(format!("音声の準備がタイムアウトしました（{label}）: {e}")),
            }
        }
        Ok(session)
    }
    pub fn health(&self) -> Result<(), String> {
        if self
            .workers
            .iter()
            .any(|worker| worker.join.as_ref().is_some_and(|join| join.is_finished()))
        {
            return Err(
                "音声録音が停止しました。録画を停止してデバイス・空き容量を確認してください".into(),
            );
        }
        Ok(())
    }
    pub fn stop(&mut self) -> Result<(), String> {
        for worker in &self.workers {
            worker.stop.store(true, Ordering::SeqCst);
        }
        let mut error = None;
        for worker in &mut self.workers {
            if let Some(join) = worker.join.take() {
                match join.join() {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => error = Some(e),
                    Err(_) => error = Some("音声録音スレッドが終了しました".into()),
                }
            }
        }
        error.map_or(Ok(()), Err)
    }
}
impl Drop for AudioRecording {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
fn capture(
    path: PathBuf,
    loopback: bool,
    stop: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    ready: &std::sync::mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    wasapi::initialize_mta().ok().map_err(|e| e.to_string())?;
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            wasapi::deinitialize();
        }
    }
    let _com = Com;
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = enumerator
        .get_default_device(&if loopback {
            Direction::Render
        } else {
            Direction::Capture
        })
        .map_err(|e| e.to_string())?;
    let mut client = device.get_iaudioclient().map_err(|e| e.to_string())?;
    let format = WaveFormat::new(16, 16, &SampleType::Int, 48000, 2, None);
    client
        .initialize_client(
            &format,
            &Direction::Capture,
            &StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: 1_000_000,
            },
        )
        .map_err(|e| e.to_string())?;
    let event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
    let capture: IAudioCaptureClient =
        unsafe { client.as_iaudioclient().GetService() }.map_err(|e| e.to_string())?;
    let mut writer = hound::WavWriter::create(
        &path,
        hound::WavSpec {
            channels: 2,
            sample_rate: 48000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .map_err(|e| e.to_string())?;
    ready.send(Ok(())).map_err(|e| e.to_string())?;
    while epoch.load(Ordering::SeqCst) == 0 && !stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(2));
    }
    let origin = epoch.load(Ordering::SeqCst);
    let mut written = 0u64;
    client.start_stream().map_err(|e| e.to_string())?;
    while !stop.load(Ordering::SeqCst) {
        let _ = event.wait_for_event(100);
        loop {
            let size = unsafe { capture.GetNextPacketSize() }.map_err(|e| e.to_string())?;
            if size == 0 {
                break;
            }
            let (mut data, mut frames, mut flags, mut position, mut stamp) =
                (std::ptr::null_mut(), 0, 0, 0, 0);
            unsafe {
                capture.GetBuffer(
                    &mut data,
                    &mut frames,
                    &mut flags,
                    Some(&mut position),
                    Some(&mut stamp),
                )
            }
            .map_err(|e| e.to_string())?;
            // Always release the native packet, including on a disk write error.
            let result = (|| -> Result<(), String> {
                let desired = if flags & 4 != 0 {
                    written
                } else {
                    stamp.saturating_sub(origin) * 48000 / 10_000_000
                };
                while written < desired {
                    writer.write_sample(0i16).map_err(|e| e.to_string())?;
                    writer.write_sample(0i16).map_err(|e| e.to_string())?;
                    written += 1;
                }
                for frame in 0..frames as usize {
                    let at = desired + frame as u64;
                    if at < written {
                        continue;
                    }
                    for channel in 0..2 {
                        let sample = if flags & 2 != 0 || data.is_null() {
                            0
                        } else {
                            let p = unsafe { data.add((frame * 2 + channel) * 2) };
                            i16::from_le_bytes(unsafe { [p.read(), p.add(1).read()] })
                        };
                        writer.write_sample(sample).map_err(|e| e.to_string())?;
                    }
                    written += 1;
                }
                Ok(())
            })();
            unsafe { capture.ReleaseBuffer(frames) }.map_err(|e| e.to_string())?;
            result?;
        }
    }
    client.stop_stream().map_err(|e| e.to_string())?;
    let end = timestamp().saturating_sub(origin) * 48000 / 10_000_000;
    while written < end {
        writer.write_sample(0i16).map_err(|e| e.to_string())?;
        writer.write_sample(0i16).map_err(|e| e.to_string())?;
        written += 1;
    }
    writer
        .finalize()
        .map_err(|e| format!("音声ファイルを保存できません: {e}"))
}
