export interface RecordingOptions {
  cursor: boolean;
  quality: "standard" | "high";
  microphone: boolean;
  systemAudio: boolean;
}
export interface RecordingResult {
  blob: Blob;
  extension: "mp4" | "webm";
  seconds: number;
  hasAudio: boolean;
}
export interface RecordingSession {
  pause(): void;
  resume(): void;
  stop(): void;
  readonly paused: boolean;
  /** Recorded seconds, excluding pauses. */
  seconds(): number;
  /** Resolves when recording stops, including via the browser's "stop sharing" button. */
  finished: Promise<RecordingResult>;
}

export const recordingSupported = () =>
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getDisplayMedia &&
  typeof MediaRecorder !== "undefined";

function pickFormat() {
  const candidates: [string, "mp4" | "webm"][] = [
    ["video/mp4;codecs=avc1.640028,mp4a.40.2", "mp4"],
    ["video/mp4;codecs=avc1,mp4a.40.2", "mp4"],
    ["video/webm;codecs=vp9,opus", "webm"],
    ["video/webm;codecs=vp8,opus", "webm"],
    ["video/webm", "webm"],
  ];
  return (
    candidates.find(([type]) => MediaRecorder.isTypeSupported(type)) ??
    candidates[candidates.length - 1]
  );
}

/** Asks the browser for a screen, window or tab, then waits for start(). */
export async function prepareRecording(options: RecordingOptions) {
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 30, max: 30 },
      cursor: options.cursor ? "always" : "never",
    } as MediaTrackConstraints,
    audio: options.systemAudio,
    // Chrome/Edge: offer the "share system audio" checkbox and keep this tab out of the picker list.
    systemAudio: options.systemAudio ? "include" : "exclude",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  } as DisplayMediaStreamOptions);
  let mic: MediaStream | null = null;
  try {
    if (options.microphone)
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    display.getTracks().forEach((t) => t.stop());
    throw new Error(`マイクを使用できません: ${e instanceof Error ? e.message : String(e)}`);
  }
  const sources = [display, mic].filter(
    (s): s is MediaStream => !!s && s.getAudioTracks().length > 0,
  );
  let context: AudioContext | null = null;
  const tracks: MediaStreamTrack[] = [...display.getVideoTracks()];
  if (sources.length === 1) tracks.push(...sources[0].getAudioTracks());
  else if (sources.length > 1) {
    context = new AudioContext();
    const mixed = context.createMediaStreamDestination();
    for (const s of sources) context.createMediaStreamSource(s).connect(mixed);
    tracks.push(...mixed.stream.getAudioTracks());
  }
  const release = () => {
    display.getTracks().forEach((t) => t.stop());
    mic?.getTracks().forEach((t) => t.stop());
    void context?.close();
  };
  return {
    hasAudio: sources.length > 0,
    cancel: release,
    start: () => startSession(new MediaStream(tracks), options, sources.length > 0, release),
  };
}

function startSession(
  stream: MediaStream,
  options: RecordingOptions,
  hasAudio: boolean,
  release: () => void,
): RecordingSession {
  const [mimeType, extension] = pickFormat();
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: options.quality === "high" ? 12_000_000 : 5_000_000,
    audioBitsPerSecond: 192_000,
  });
  const chunks: Blob[] = [];
  let elapsed = 0,
    resumedAt = performance.now(),
    paused = false;
  const finished = new Promise<RecordingResult>((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onerror = (e) => {
      release();
      reject(new Error(`録画に失敗しました: ${String((e as ErrorEvent).error ?? e)}`));
    };
    recorder.onstop = () => {
      release();
      if (!paused) elapsed += performance.now() - resumedAt;
      paused = true;
      if (!chunks.length) reject(new Error("録画データがありません"));
      else
        resolve({
          blob: new Blob(chunks, { type: mimeType.split(";")[0] }),
          extension,
          seconds: elapsed / 1000,
          hasAudio,
        });
    };
  });
  // The browser's own "stop sharing" control ends the video track.
  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (recorder.state !== "inactive") recorder.stop();
  });
  recorder.start(1000);
  return {
    get paused() {
      return paused;
    },
    pause() {
      if (recorder.state !== "recording") return;
      recorder.pause();
      elapsed += performance.now() - resumedAt;
      paused = true;
    },
    resume() {
      if (recorder.state !== "paused") return;
      recorder.resume();
      resumedAt = performance.now();
      paused = false;
    },
    stop() {
      if (recorder.state !== "inactive") recorder.stop();
    },
    seconds: () => (elapsed + (paused ? 0 : performance.now() - resumedAt)) / 1000,
    finished,
  };
}
