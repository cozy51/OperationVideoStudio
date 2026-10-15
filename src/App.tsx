import React, { useCallback, useEffect, useRef, useState } from "react";
import appIcon from "./assets/app-icon.png";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  cutRange,
  cutProject,
  duration,
  emptyProject,
  formatTime,
  locate,
  moveClip,
  split,
  validateProject,
  type Media,
  type Project,
} from "./editor";

import {
  AnnotationTools,
  AnnotationProperties,
  OverlayPreview,
  AnnotationTrack,
} from "./AnnotationEditor";
import {
  renderAssets,
  outputSize,
  type Annotation,
  type ClickInfo,
} from "./annotations";
import { AudioPlayback, AudioProperties } from "./AudioTrack";
import type { AudioClip } from "./editor";
type Target = {
  id: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
type ToolStatus = { ready: boolean; details: string; directory: string | null };
type Status = { active: boolean; paused: boolean; seconds: number };
type Progress = { progress: number; done: boolean; error: string | null };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
function useEvent<T>(name: string, handler: (payload: T) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let off: (() => void) | undefined;
    listen<T>(name, (e) => latest.current(e.payload)).then((unlisten) => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [name]);
}
export function RecordingBar() {
  const [status, setStatus] = useState<Status>({
    active: false,
    paused: false,
    seconds: 0,
  });
  const [count, setCount] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEvent<number>("record-countdown", setCount);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const status = await invoke<Status>("record_status");
        if (disposed) return;
        setStatus(status);
        if (status.active) setCount(0);
      } catch (e) {
        if (disposed) return;
        setError(message(e));
        // A failed encoder still has a backend session to stop and clean up.
        setStatus((s) => ({ ...s, active: true }));
      }
      if (!disposed) timer = setTimeout(() => void poll(), 500);
    }
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  async function act(command: string) {
    setBusy(true);
    try {
      await invoke(command);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="recordbar">
      <strong>
        ● {count ? `${count} 秒後に録画` : formatTime(status.seconds)}
      </strong>
      <button
        disabled={!status.active || busy}
        onClick={() =>
          void act(status.paused ? "resume_recording" : "pause_recording")
        }
      >
        {status.paused ? "再開" : "一時停止"}
      </button>
      <button
        className="danger"
        disabled={!status.active || busy}
        onClick={() => void act("stop_recording")}
      >
        停止・編集
      </button>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
export function CaptureOutline() {
  useEffect(() => {
    void invoke("capture_outline_ready").catch(() => {});
  }, []);
  return (
    <div className="capture-outline">
      <span>録画対象</span>
    </div>
  );
}
export function RegionPicker() {
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const [end, setEnd] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape")
        void invoke("close_region").catch((e) => setError(message(e)));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const params = new URLSearchParams(location.hash.split("?")[1]);
  return (
    <div
      className="region-overlay"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setOrigin({ x: e.clientX, y: e.clientY });
        setEnd({ x: e.clientX, y: e.clientY });
      }}
      onPointerMove={(e) => {
        if (origin) setEnd({ x: e.clientX, y: e.clientY });
      }}
      onPointerUp={(e) => {
        if (!origin) return;
        const d = devicePixelRatio;
        void invoke("complete_region", {
          x:
            Number(params.get("x")) +
            Math.round(Math.min(origin.x, e.clientX) * d),
          y:
            Number(params.get("y")) +
            Math.round(Math.min(origin.y, e.clientY) * d),
          width: Math.round(Math.abs(e.clientX - origin.x) * d),
          height: Math.round(Math.abs(e.clientY - origin.y) * d),
        }).catch((e) => {
          setError(message(e));
          setOrigin(null);
          setEnd(null);
        });
      }}
    >
      <div className="region-help">
        録画する範囲をドラッグしてください　•　Escでキャンセル {error}
      </div>
      {origin && end && (
        <div
          className="region-box"
          style={{
            left: Math.min(origin.x, end.x),
            top: Math.min(origin.y, end.y),
            width: Math.abs(end.x - origin.x),
            height: Math.abs(end.y - origin.y),
          }}
        />
      )}
    </div>
  );
}
export function App() {
  const [project, setProject] = useState<Project>(emptyProject);
  const [past, setPast] = useState<Project[]>([]);
  const [future, setFuture] = useState<Project[]>([]);
  const current = useRef(project);
  current.current = project;
  const [selectedAudio, setSelectedAudio] = useState<string | null>(null);
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(
    null,
  );
  const [gapSeconds, setGapSeconds] = useState(2);
  const [time, setTime] = useState(0);
  const [sourcePreview, setSourcePreview] = useState<{
    mediaId: string;
    time: number;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const outlineQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [recordDialog, setRecordDialog] = useState(false);
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [recordingFolder, setRecordingFolder] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState<Target | null>(null);
  const [microphone, setMicrophone] = useState(false);
  const [systemAudio, setSystemAudio] = useState(false);
  const [highlightClicks, setHighlightClicks] = useState(false);
  const [cursor, setCursor] = useState(true);
  const [quality, setQuality] = useState("standard");
  const [recording, setRecording] = useState(false);
  const [count, setCount] = useState(0);
  const [resolution, setResolution] = useState("1080p");
  const [cutStart, setCutStart] = useState(10);
  const [cutEnd, setCutEnd] = useState(15);
  const [recovery, setRecovery] = useState<Project | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const drag = useRef<{
    from: number;
    over: number;
    originX: number;
    moved: boolean;
  } | null>(null);
  const dragMoved = useRef(false);
  const endHandled = useRef(false);
  const total = duration(project.clips);
  const sourceMedia = project.media.find(
    (m) => m.id === sourcePreview?.mediaId,
  );
  const hit =
    sourceMedia && sourcePreview
      ? {
          clip: {
            id: `source:${sourceMedia.id}`,
            muted: false,
            gain: 1,
            mediaId: sourceMedia.id,
            start: 0,
            end: sourceMedia.duration,
          },
          index: -1,
          offset: 0,
          sourceTime: sourcePreview.time,
        }
      : locate(project.clips, time);
  const media =
    sourceMedia ?? project.media.find((m) => m.id === hit?.clip.mediaId);
  const viewTime = sourcePreview?.time ?? time;
  const viewTotal = sourceMedia?.duration ?? total;
  const audio = project.audio ?? [];
  const audioItem = audio.find((a) => a.id === selectedAudio);
  const annotations = project.annotations ?? [];
  const annotation = annotations.find((a) => a.id === selectedAnnotation);
  const firstMedia = project.media.find(
    (m) => m.id === project.clips[0]?.mediaId,
  );
  const [outputWidth, outputHeight] = outputSize(firstMedia, resolution);
  const selectedIndex = project.clips.findIndex((c) => c.id === selected);
  const selectedClip = project.clips.find((c) => c.id === selected);
  const exporting = progress !== null && !progress.done;
  const disabled = busy || exporting || recording;
  const commit = useCallback((p: Project) => {
    setPast((h) => [...h.slice(-49), current.current]);
    setFuture([]);
    const length = duration(p.clips);
    setProject({
      ...p,
      audio: (p.audio ?? [])
        .map((a) => ({ ...a, end: Math.min(a.end, a.start + length - a.at) }))
        .filter((a) => a.end > a.start),
      clicks: (p.clicks ?? []).filter((c) => c.time < length),
      annotations: (p.annotations ?? [])
        .map((a) => ({ ...a, end: Math.min(a.end, length) }))
        .filter((a) => a.end > a.start),
    });
    setSourcePreview(null);
    setPlaying(false);
    setTime((t) => Math.min(t, duration(p.clips)));
  }, []);
  const addMedia = useCallback(
    (items: Media[]) => {
      if (!items.length) return;
      const p = current.current;
      commit({
        ...p,
        media: [...p.media, ...items],
        clips: [
          ...p.clips,
          ...items.map((m) => ({
            id: crypto.randomUUID(),
            mediaId: m.id,
            start: 0,
            end: m.duration,
          })),
        ],
      });
      setNotice(`${items.length}本の動画を追加しました。`);
    },
    [commit],
  );
  const undo = useCallback(() => {
    if (!past.length) return;
    const p = past[past.length - 1];
    setFuture((f) => [current.current, ...f]);
    setPast(past.slice(0, -1));
    setProject(p);
    setSourcePreview(null);
    setTime((t) => Math.min(t, duration(p.clips)));
    setPlaying(false);
  }, [past]);
  const redo = useCallback(() => {
    if (!future.length) return;
    const p = future[0];
    setPast((h) => [...h, current.current]);
    setFuture(future.slice(1));
    setProject(p);
    setSourcePreview(null);
    setTime((t) => Math.min(t, duration(p.clips)));
    setPlaying(false);
  }, [future]);
  async function task<T>(run: () => Promise<T>) {
    setBusy(true);
    setError("");
    try {
      return await run();
    } catch (e) {
      setError(message(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  async function importVideos() {
    await task(async () => addMedia(await invoke<Media[]>("import_videos")));
  }
  useEvent<Media & { clicks?: ClickInfo[] }>("recording-finished", (m) => {
    setRecording(false);
    const { clicks = [], ...source } = m;
    const p = current.current,
      offset = duration(p.clips);
    commit({
      ...p,
      version: 2,
      media: [...p.media, source],
      clips: [
        ...p.clips,
        {
          id: crypto.randomUUID(),
          mediaId: source.id,
          start: 0,
          end: source.duration,
        },
      ],
      clicks: [
        ...(p.clicks ?? []),
        ...clicks.map((c) => ({
          ...c,
          time: c.time + offset,
          mediaId: source.id,
        })),
      ],
    });
    setRecordDialog(false);
    setCount(0);
  });
  useEvent<null>("recording-stopped", () => setRecording(false));
  useEvent<number>("record-countdown", setCount);
  useEvent<Target>("region-selected", (t) => {
    setTarget(t);
    setTargets((list) => [...list.filter((i) => i.kind !== "region"), t]);
  });
  useEvent<Progress>("export-progress", (p) => {
    setProgress(p);
    if (p.done) {
      if (p.error) setError(p.error);
      else setNotice("MP4の書き出しが完了しました。");
    }
  });
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<Project | null>("recover_project")
      .then((p) => {
        if (p && p.clips.length) setRecovery(validateProject(p));
      })
      .catch((e) => setError(message(e)));
  }, []);
  useEffect(() => {
    if (!isTauri() || !project.media.length) return;
    const timer = setTimeout(
      () =>
        void invoke("autosave", { project }).catch((e) =>
          setError(`自動保存に失敗しました: ${message(e)}`),
        ),
      1000,
    );
    return () => clearTimeout(timer);
  }, [project]);
  useEvent<Media[]>("media-dropped", (items) => {
    if (!disabled) addMedia(items);
    else setError("処理が完了してから動画を追加してください。");
  });
  useEvent<string>("backend-error", setError);
  useEffect(() => {
    const v = video.current;
    if (!v || !hit) return;
    if (Math.abs(v.currentTime - hit.sourceTime) > 0.12)
      v.currentTime = hit.sourceTime;
    v.playbackRate = rate;
    v.volume = sourcePreview
      ? 1
      : Math.min(1, Math.max(0, hit.clip.muted ? 0 : (hit.clip.gain ?? 1)));
    endHandled.current = false;
    if (playing)
      void v.play().catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setPlaying(false);
        setError(
          `プレビューを再生できません: ${message(e)}。元動画のコーデックがWebView2に非対応の場合はH.264 MP4に変換してください。`,
        );
      });
    else v.pause();
  }, [hit?.clip.id, media?.id, playing, rate, hit?.clip.muted, hit?.clip.gain]);
  useEffect(() => {
    if (!playing || media?.kind !== "gap" || !hit) return;
    let last = performance.now(),
      frame = 0;
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * rate;
      last = now;
      if (sourcePreview)
        setSourcePreview((prev) =>
          prev
            ? { ...prev, time: Math.min(media.duration, prev.time + dt) }
            : null,
        );
      else setTime((prev) => Math.min(total, prev + dt));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, media?.id, rate, !!sourcePreview]);
  useEffect(() => {
    if (
      playing &&
      media?.kind === "gap" &&
      hit &&
      hit.sourceTime >= hit.clip.end
    ) {
      if (sourcePreview) setPlaying(false);
      else if (time >= total) setPlaying(false);
    }
  }, [playing, time, sourcePreview?.time, media?.kind]);
  function seek(next: number) {
    if (sourcePreview && sourceMedia) {
      const t = Math.min(sourceMedia.duration, Math.max(0, next));
      setSourcePreview({ ...sourcePreview, time: t });
      if (video.current) video.current.currentTime = t;
      return;
    }
    seekTimeline(next);
  }
  function seekTimeline(next: number) {
    setSourcePreview(null);
    const t = Math.min(total, Math.max(0, next));
    setTime(t);
    const h = locate(project.clips, t);
    if (video.current && h && h.clip.id === hit?.clip.id)
      video.current.currentTime = h.sourceTime;
  }
  function advance() {
    if (!hit || endHandled.current) return;
    endHandled.current = true;
    if (sourcePreview && sourceMedia) {
      setPlaying(false);
      setSourcePreview({ ...sourcePreview, time: sourceMedia.duration });
      return;
    }
    const next = project.clips[hit.index + 1];
    if (next) {
      setTime(hit.offset + hit.clip.end - hit.clip.start);
    } else {
      setPlaying(false);
      setTime(total);
    }
  }
  function deleteSelected() {
    if (!selected) return;
    commit({
      ...project,
      clips: project.clips.filter((c) => c.id !== selected),
    });
    setSelected(null);
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).matches("input,select,textarea") ||
        disabled ||
        recordDialog
      )
        return;
      if (e.ctrlKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (e.ctrlKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (e.ctrlKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (isTauri())
          void task(async () => {
            await invoke("save_project", { project });
          });
      } else if (e.ctrlKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (!sourcePreview)
          commit({ ...project, clips: split(project.clips, time) });
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        setPlaying(false);
        seek(viewTime + (e.key === "ArrowRight" ? 1 : -1) / 30);
      } else if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "Delete") {
        e.preventDefault();
        if (selectedAnnotation) {
          commit({
            ...project,
            annotations: annotations.filter((a) => a.id !== selectedAnnotation),
          });
          setSelectedAnnotation(null);
        } else deleteSelected();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  useEffect(() => {
    if (!isTauri() || !recordDialog || !target) return;
    let active = true;
    const update = () => {
      outlineQueue.current = outlineQueue.current
        .catch(() => {})
        .then(async () => {
          if (!active) return;
          try {
            await invoke("show_capture_outline", { targetId: target.id });
          } catch (e) {
            if (active) {
              const error = message(e);
              setError(error);
              if (
                target.kind === "window" &&
                /最小化|閉じられ|別のウィンドウ/.test(error)
              ) {
                const list = await invoke<Target[]>("capture_targets");
                if (active) {
                  setTargets(list);
                  setTarget(null);
                }
              }
            }
          }
        });
    };
    update();
    const timer = setInterval(update, 1000);
    return () => {
      active = false;
      clearInterval(timer);
      outlineQueue.current = outlineQueue.current
        .catch(() => {})
        .then(() => invoke("hide_capture_outline"))
        .catch(() => {});
    };
  }, [recordDialog, target?.id]);
  async function refreshTargets() {
    await task(async () => {
      const list = await invoke<Target[]>("capture_targets");
      if (target?.kind === "region") list.push(target);
      setTargets(list);
      setTarget(list.find((t) => t.id === target?.id) ?? null);
    });
  }
  async function openRecording() {
    setRecordDialog(true);
    setCount(0);
    setTools(null);
    await task(async () => {
      const [list, status, folder] = await Promise.all([
        invoke<Target[]>("capture_targets"),
        invoke<ToolStatus>("recording_tools"),
        invoke<string | null>("recording_folder"),
      ]);
      setTargets(list);
      setTarget(list[0] ?? null);
      setTools(status);
      setRecordingFolder(folder);
    });
  }
  function changeAudio(a: AudioClip) {
    commit({
      ...project,
      audio: audio.map((item) => (item.id === a.id ? a : item)),
    });
  }
  function addAudio() {
    if (!sourceMedia?.hasAudio || !total) return;
    const at = Math.min(time, Math.max(0, total - 0.1));
    const a: AudioClip = {
      id: crypto.randomUUID(),
      mediaId: sourceMedia.id,
      start: 0,
      end: Math.min(sourceMedia.duration, total - at),
      at,
      gain: 1,
      muted: false,
    };
    commit({ ...project, version: 2, audio: [...audio, a] });
    setSelectedAudio(a.id);
    setSelectedAnnotation(null);
    setSelected(null);
  }
  function changeAnnotation(a: Annotation) {
    commit({
      ...project,
      annotations: annotations.map((item) => (item.id === a.id ? a : item)),
    });
  }
  function addAnnotation(a: Annotation) {
    commit({ ...project, version: 2, annotations: [...annotations, a] });
    setSelectedAnnotation(a.id);
    setSelectedAudio(null);
    setSelected(null);
  }
  function insertGap() {
    const media: Media = {
      id: crypto.randomUUID(),
      kind: "gap",
      path: "",
      name: `黒画面・無音 ${gapSeconds}秒`,
      duration: gapSeconds,
      width: outputWidth,
      height: outputHeight,
      hasAudio: false,
    };
    addMedia([media]);
  }
  function renameSelected(name: string) {
    if (!selectedClip) return;
    const next = name.trim() || undefined;
    if (next === selectedClip.name) return;
    commit({
      ...project,
      clips: project.clips.map((c) =>
        c.id === selected ? { ...c, name: next } : c,
      ),
    });
  }
  function moveSelected(delta: number) {
    if (selectedIndex < 0) return;
    commit({
      ...project,
      clips: moveClip(project.clips, selectedIndex, selectedIndex + delta),
    });
  }
  async function changeRecordingFolder() {
    await task(async () => {
      const folder = await invoke<string | null>("choose_recording_folder");
      if (folder) setRecordingFolder(folder);
    });
  }
  async function chooseFFmpeg() {
    await task(async () => {
      const status = await invoke<ToolStatus | null>("choose_ffmpeg_folder");
      if (status) setTools(status);
    });
  }
  async function startRecording() {
    if (!target || !tools?.ready) return;
    await task(async () => {
      setPlaying(false);
      try {
        const started = await invoke<boolean>("start_recording", {
          options: {
            target,
            cursor,
            quality,
            microphone,
            systemAudio,
            highlightClicks,
          },
        });
        setRecording(started);
        if (started) setRecordDialog(false);
      } finally {
        setCount(0);
      }
    });
  }
  async function doExport() {
    setProgress({ progress: 0, done: false, error: null });
    try {
      const saved = await invoke<boolean>("export_video", {
        project,
        resolution,
        assets: renderAssets(
          annotations,
          outputWidth,
          outputHeight,
          !!project.clicks?.length,
        ),
      });
      if (!saved) setProgress(null);
    } catch (e) {
      setProgress({ progress: 0, done: true, error: message(e) });
      setError(message(e));
    }
  }
  return (
    <div className="app">
      <header>
        <div className="brand">
          <img className="brand-icon" src={appIcon} alt="" />
          <div>
            <h1>Operation Video Studio</h1>
            <small>録画して、整えて、伝える。</small>
          </div>
        </div>
        <div className="toolbar">
          <button
            className="record"
            disabled={disabled || !isTauri()}
            onClick={() => void openRecording()}
          >
            ● 録画
          </button>
          <button
            disabled={disabled || !isTauri()}
            onClick={() => void importVideos()}
          >
            ＋ 動画追加
          </button>
          <button
            disabled={disabled || !isTauri()}
            onClick={() =>
              void task(async () => {
                if (await invoke("save_project", { project }))
                  setNotice("プロジェクトを保存しました。");
              })
            }
          >
            保存
          </button>
          <button
            className="primary"
            disabled={disabled || !project.clips.length || !isTauri()}
            onClick={() => void doExport()}
          >
            MP4を書き出す ↗
          </button>
        </div>
      </header>
      <div className="steps">
        <span className="active">1　録画・動画追加</span>
        <span>›</span>
        <span>2　不要な部分をカット</span>
        <span>›</span>
        <span>3　並べ替えて書き出し</span>
        <button
          disabled={disabled || !isTauri()}
          onClick={() =>
            void task(async () => {
              const p = await invoke<Project | null>("open_project");
              if (p) {
                commit(validateProject(p));
                setTime(0);
              }
            })
          }
        >
          プロジェクトを開く
        </button>
      </div>
      {!isTauri() && (
        <div className="info">
          ブラウザ表示ではファイル・録画機能は利用できません。Windowsでデスクトップアプリを起動してください。
        </div>
      )}
      {recovery && (
        <div className="info">
          前回の編集データがあります。
          <button
            onClick={() => {
              commit(recovery);
              setRecovery(null);
            }}
          >
            復旧する
          </button>
          <button onClick={() => setRecovery(null)}>閉じる</button>
        </div>
      )}
      {error && !recordDialog && (
        <div className="error" role="alert">
          {error}
          <button onClick={() => setError("")}>閉じる</button>
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
          <button onClick={() => setNotice("")}>×</button>
        </div>
      )}
      <main>
        <aside className="library">
          <h2>
            プロジェクトの動画 <span>{project.media.length}</span>
          </h2>
          <p className="hint">
            クリック：内容を再生 ／ ダブルクリック：末尾に追加
          </p>
          <div className="media-list">
            {project.media.map((m) => (
              <button
                className="media-card"
                disabled={disabled}
                key={m.id}
                aria-label={`素材 ${m.name}`}
                title={`${m.name}（${m.width}×${m.height}）\nクリックで内容を再生、ダブルクリックで末尾に追加`}
                onClick={() => {
                  setSourcePreview({ mediaId: m.id, time: 0 });
                  setSelected(null);
                  setPlaying(true);
                  if (video.current && media?.id === m.id)
                    video.current.currentTime = 0;
                }}
                onDoubleClick={() =>
                  commit({
                    ...project,
                    clips: [
                      ...project.clips,
                      {
                        id: crypto.randomUUID(),
                        mediaId: m.id,
                        start: 0,
                        end: m.duration,
                      },
                    ],
                  })
                }
              >
                <span className="thumbnail" aria-hidden="true">
                  ▶
                </span>
                <span className="media-info">
                  <strong>{m.name}</strong>
                  <small>
                    {formatTime(m.duration)}・{m.hasAudio ? "音声あり" : "音声なし"}
                  </small>
                </span>
              </button>
            ))}
            {!project.media.length && (
              <div className="empty-library">
                動画がまだありません
                <br />
                上の「録画」または
                <br />
                「動画追加」から始めましょう。
              </div>
            )}
          </div>
          <AnnotationTools
            time={time}
            total={total}
            add={addAnnotation}
            disabled={disabled || !!sourcePreview}
          />
          <label>
            黒画面・無音（秒）
            <input
              type="number"
              min=".1"
              max="600"
              step=".1"
              value={gapSeconds}
              onChange={(e) => setGapSeconds(Number(e.target.value))}
            />
          </label>
          <button
            disabled={
              disabled ||
              !Number.isFinite(gapSeconds) ||
              gapSeconds < 0.1 ||
              gapSeconds > 600
            }
            onClick={insertGap}
          >
            黒画面・無音を末尾に追加
          </button>
        </aside>
        <section className="preview-panel">
          <div className="panel-title">
            <h2>
              {sourceMedia ? `素材確認：${sourceMedia.name}` : "プレビュー"}
            </h2>
            {sourceMedia ? (
              <>
                <button
                  disabled={!sourceMedia.hasAudio || !total || disabled}
                  onClick={addAudio}
                >
                  この素材の音声だけを追加
                </button>
                <button
                  onClick={() => {
                    setPlaying(false);
                    setSourcePreview(null);
                  }}
                >
                  編集結果へ戻る
                </button>
              </>
            ) : (
              <span>編集後 {formatTime(total)}</span>
            )}
          </div>
          <div
            className="preview"
            style={{
              aspectRatio: `${outputWidth}/${outputHeight}`,
              maxWidth: `calc(55vh * ${outputWidth / outputHeight})`,
              maxHeight: "none",
              alignSelf: "center",
            }}
          >
            {media?.kind === "gap" ? (
              <div className="gap-preview" />
            ) : media && hit ? (
              <video
                ref={video}
                key={media.id}
                src={convertFileSrc(media.previewPath ?? media.path)}
                onLoadedMetadata={() => {
                  if (video.current) {
                    video.current.currentTime = hit.sourceTime;
                    video.current.playbackRate = rate;
                    if (playing)
                      void video.current.play().catch((e) => {
                        if (!(
                          e instanceof DOMException && e.name === "AbortError"
                        ))
                          setError(message(e));
                      });
                  }
                }}
                onTimeUpdate={() => {
                  const v = video.current;
                  if (!v || !hit || !playing) return;
                  if (v.currentTime >= hit.clip.end - 0.015) {
                    advance();
                  } else if (sourcePreview) {
                    setSourcePreview({ ...sourcePreview, time: v.currentTime });
                  } else
                    setTime(
                      hit.offset + Math.max(0, v.currentTime - hit.clip.start),
                    );
                }}
                onEnded={advance}
                onError={() => {
                  setPlaying(false);
                  setError(
                    "この動画はプレビューできません。Windows WebView2が対応するH.264/AACのMP4を使用してください。",
                  );
                }}
              />
            ) : (
              <div className="preview-empty">
                <span>▷</span>
                <h3>ここに動画を表示します</h3>
                <p>操作の録画、または動画ファイルの追加から始めてください。</p>
              </div>
            )}
            {!sourcePreview &&
              (annotations.length > 0 || !!project.clicks?.length) && (
                <OverlayPreview
                  items={annotations}
                  time={time}
                  w={outputWidth}
                  h={outputHeight}
                  selected={selectedAnnotation}
                  select={(id) => {
                    setSelectedAnnotation(id);
                    setSelected(null);
                    setPlaying(false);
                  }}
                  change={changeAnnotation}
                  video={video}
                  clicks={project.clicks ?? []}
                  media={project.media}
                />
              )}
          </div>
          <div className="playback">
            <button
              aria-label="前のフレーム"
              disabled={!media || disabled}
              onClick={() => {
                setPlaying(false);
                seek(viewTime - 1 / 30);
              }}
            >
              ❮
            </button>
            <button
              className="play-button"
              disabled={!media || disabled}
              onClick={() => {
                if (viewTime >= viewTotal) seek(0);
                setPlaying((p) => !p);
              }}
            >
              {playing ? "Ⅱ" : "▶"}
            </button>
            <button
              aria-label="次のフレーム"
              disabled={!media || disabled}
              onClick={() => {
                setPlaying(false);
                seek(viewTime + 1 / 30);
              }}
            >
              ❯
            </button>
            <span className="time">
              {formatTime(viewTime)} / {formatTime(viewTotal)}
            </span>
            <label>
              速度{" "}
              <select
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
              >
                {[0.5, 1, 1.5, 2].map((r) => (
                  <option key={r} value={r}>
                    {r}倍
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
        <aside className="properties">
          <h2>編集・書き出し設定</h2>
          {audioItem && (
            <AudioProperties
              item={audioItem}
              total={total}
              sourceDuration={
                project.media.find((m) => m.id === audioItem.mediaId)
                  ?.duration ?? 0
              }
              change={changeAudio}
              remove={() => {
                commit({
                  ...project,
                  audio: audio.filter((a) => a.id !== audioItem.id),
                });
                setSelectedAudio(null);
              }}
            />
          )}
          {annotation && (
            <AnnotationProperties
              item={annotation}
              total={total}
              change={changeAnnotation}
              remove={() => {
                commit({
                  ...project,
                  annotations: annotations.filter(
                    (a) => a.id !== annotation.id,
                  ),
                });
                setSelectedAnnotation(null);
              }}
              duplicate={() =>
                addAnnotation({ ...annotation, id: crypto.randomUUID() })
              }
            />
          )}

          <label>
            書き出し解像度
            <select
              value={resolution}
              disabled={disabled}
              onChange={(e) => setResolution(e.target.value)}
            >
              <option value="1080p">1080p（フルHD）</option>
              <option value="720p">720p（HD）</option>
              <option value="source">先頭動画に合わせる</option>
            </select>
          </label>
          <p className="hint">
            MP4 / H.264 + AAC / 30fps
            <br />
            元のファイルは変更しません。
          </p>
          <hr />
          <h3>選択中のクリップ</h3>
          {selectedClip ? (
            <>
              <label>
                クリップ名
                <input
                  type="text"
                  maxLength={100}
                  disabled={disabled}
                  key={`${selectedClip.id}:${selectedClip.name ?? ""}`}
                  defaultValue={
                    selectedClip.name ??
                    project.media.find((m) => m.id === selectedClip.mediaId)
                      ?.name ??
                    ""
                  }
                  onBlur={(e) => renameSelected(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      e.currentTarget.value =
                        selectedClip.name ??
                        project.media.find((m) => m.id === selectedClip.mediaId)
                          ?.name ??
                        "";
                      e.currentTarget.blur();
                    }
                  }}
                />
              </label>
              <p className="hint">
                Enter
                または欄の外をクリックで確定。元動画のファイル名は変更しません。
              </p>
              <p>
                {formatTime(selectedClip.start)} 〜{" "}
                {formatTime(selectedClip.end)}
              </p>
              <button
                disabled={disabled}
                className="danger"
                onClick={deleteSelected}
              >
                このクリップを削除
              </button>
            </>
          ) : (
            <p className="hint">
              下のタイムラインでクリップを選択してください。
            </p>
          )}
          <hr />
          <h3>不要な区間を削除</h3>
          <p className="hint">編集後の時間で指定します。</p>
          <label>
            開始（秒）
            <input
              type="number"
              min="0"
              step="0.1"
              value={cutStart}
              onChange={(e) => setCutStart(Number(e.target.value))}
            />
          </label>
          <button
            className="text-button"
            onClick={() => setCutStart(Number(time.toFixed(2)))}
          >
            現在の位置を開始にする
          </button>
          <label>
            終了（秒）
            <input
              type="number"
              min="0"
              step="0.1"
              value={cutEnd}
              onChange={(e) => setCutEnd(Number(e.target.value))}
            />
          </label>
          <button
            className="text-button"
            onClick={() => setCutEnd(Number(time.toFixed(2)))}
          >
            現在の位置を終了にする
          </button>
          <button
            disabled={
              disabled || cutEnd <= cutStart || cutStart < 0 || cutEnd > total
            }
            onClick={() => commit(cutProject(project, cutStart, cutEnd))}
          >
            区間を削除して前後をつなぐ
          </button>
        </aside>
      </main>
      <section className="timeline">
        <div className="timeline-actions">
          <h2>タイムライン</h2>
          <button
            disabled={disabled || !hit || !!sourcePreview}
            onClick={() =>
              commit({ ...project, clips: split(project.clips, time) })
            }
          >
            ✂ 現在の位置で分割
          </button>
          <button disabled={disabled || !selected} onClick={deleteSelected}>
            削除
          </button>
          <button
            disabled={disabled || selectedIndex <= 0}
            onClick={() => moveSelected(-1)}
          >
            ← 左へ移動
          </button>
          <button
            disabled={
              disabled ||
              selectedIndex < 0 ||
              selectedIndex >= project.clips.length - 1
            }
            onClick={() => moveSelected(1)}
          >
            右へ移動 →
          </button>
          <button
            title="Ctrl+Z"
            disabled={disabled || !past.length}
            onClick={undo}
          >
            ↶ 元に戻す
          </button>
          <button
            title="Ctrl+Y"
            disabled={disabled || !future.length}
            onClick={redo}
          >
            ↷ やり直す
          </button>
          <label className="zoom">
            縮小{" "}
            <input
              aria-label="タイムライン倍率"
              type="range"
              min="0.5"
              max="4"
              step="0.25"
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />{" "}
            拡大
          </label>
        </div>
        <div className="timeline-scroll">
          <div
            className="timeline-content"
            style={{ width: `${Math.max(100, zoom * 100)}%` }}
          >
            <div className="ruler">
              {Array.from({ length: 11 }, (_, i) => (
                <span key={i}>{formatTime((total * i) / 10)}</span>
              ))}
            </div>
            <input
              className="scrubber"
              aria-label="再生位置（秒）"
              type="range"
              disabled={!total || disabled}
              min="0"
              max={Math.max(total, 0.01)}
              step="0.01"
              value={Math.min(time, total)}
              onChange={(e) => {
                setPlaying(false);
                seekTimeline(Number(e.target.value));
              }}
            />
            <div className="clip-track">
              <span className="track-label">映像</span>
              <div className="clip-row">
                {project.clips.map((c, i) => (
                  <button
                    data-clip-index={i}
                    aria-label={`クリップ ${i + 1}: ${c.name ?? project.media.find((m) => m.id === c.mediaId)?.name}`}
                    disabled={disabled}
                    key={c.id}
                    className={`clip ${selected === c.id ? "selected" : ""} ${dropIndex === i ? "drop-target" : ""}`}
                    style={{ width: `${((c.end - c.start) / total) * 100}%` }}
                    onClick={() => {
                      if (dragMoved.current) {
                        dragMoved.current = false;
                        return;
                      }
                      setSelected(c.id);
                      setSelectedAnnotation(null);
                      let t = 0;
                      for (let j = 0; j < i; j++)
                        t += project.clips[j].end - project.clips[j].start;
                      setPlaying(false);
                      seekTimeline(t);
                    }}
                  >
                    <span
                      className="clip-grip"
                      title="ここをつかみ、移動先のクリップの上で離してください"
                      aria-hidden="true"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        dragMoved.current = false;
                        drag.current = {
                          from: i,
                          over: i,
                          originX: e.clientX,
                          moved: false,
                        };
                        setSelected(c.id);
                        setSelectedAnnotation(null);
                      }}
                      onPointerMove={(e) => {
                        const info = drag.current;
                        if (!info) return;
                        if (Math.abs(e.clientX - info.originX) >= 8)
                          info.moved = true;
                        if (!info.moved) return;
                        const element = document
                          .elementFromPoint(e.clientX, e.clientY)
                          ?.closest<HTMLElement>("[data-clip-index]");
                        if (element) {
                          info.over = Number(element.dataset.clipIndex);
                          setDropIndex(info.over);
                        }
                      }}
                      onPointerUp={() => {
                        const info = drag.current;
                        drag.current = null;
                        setDropIndex(null);
                        if (info?.moved) {
                          dragMoved.current = true;
                          if (info.from !== info.over)
                            commit({
                              ...project,
                              clips: moveClip(
                                project.clips,
                                info.from,
                                info.over,
                              ),
                            });
                        }
                      }}
                      onPointerCancel={() => {
                        drag.current = null;
                        setDropIndex(null);
                      }}
                    >
                      ⋮⋮
                    </span>
                    <span className="clip-number">{i + 1}</span>
                    <strong>
                      {c.name ??
                        project.media.find((m) => m.id === c.mediaId)?.name}
                    </strong>
                    <small>{formatTime(c.end - c.start)}</small>
                  </button>
                ))}
                {!project.clips.length && (
                  <div className="empty-track">
                    動画を追加すると、ここにクリップが並びます
                  </div>
                )}
                <div
                  className="playhead"
                  style={{ left: `${total ? (time / total) * 100 : 0}%` }}
                />
              </div>
            </div>
            {total > 0 && (
              <AnnotationTrack
                items={annotations}
                total={total}
                select={(id) => {
                  setSelectedAnnotation(id);
                  setSelected(null);
                }}
                change={changeAnnotation}
              />
            )}
            {!sourcePreview && (
              <AudioPlayback
                items={audio}
                media={project.media}
                time={time}
                playing={playing}
                rate={rate}
              />
            )}
            {audio.length > 0 && (
              <div className="annotation-track">
                <span className="track-label">追加音声</span>
                <div
                  className="annotation-bars"
                  style={{ minHeight: audio.length * 38 + 10 }}
                >
                  {audio.map((a, index) => (
                    <button
                      key={a.id}
                      className="annotation-bar"
                      style={{
                        top: 5 + index * 38,
                        left: `${(a.at / total) * 100}%`,
                        width: `${((a.end - a.start) / total) * 100}%`,
                        background: "#cfeadd",
                      }}
                      onClick={() => {
                        setSelectedAudio(a.id);
                        setSelected(null);
                        setSelectedAnnotation(null);
                        seekTimeline(a.at);
                        setPlaying(false);
                      }}
                    >
                      {project.media.find((m) => m.id === a.mediaId)?.name}{" "}
                      {a.muted ? "消音" : ""}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="audio-track">
              <span className="track-label">音声</span>
              <div className="audio-clips">
                {project.clips.map((c) => (
                  <button
                    key={c.id}
                    style={{ width: `${((c.end - c.start) / total) * 100}%` }}
                    onClick={() => {
                      setSelected(c.id);
                      setSelectedAnnotation(null);
                    }}
                  >
                    {c.muted
                      ? "消音"
                      : project.media.find((m) => m.id === c.mediaId)?.hasAudio
                        ? `音声 ${Math.round((c.gain ?? 1) * 100)}%`
                        : "無音"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        <p className="hint">
          並べ替え：下の映像クリップの「⋮⋮」をつかみ、移動先のクリップの上で離します。選択して「左へ移動」「右へ移動」でも変更できます。　•　Space：再生
          / 一時停止　•　Delete：選択クリップを削除　•　Ctrl+Z：元に戻す
        </p>
      </section>
      <footer>
        <span>ローカル処理 • 外部への動画送信なし</span>
        <span>
          {busy
            ? "処理中…"
            : recording
              ? "録画中 — ツールバーから停止してください"
              : "Phase 3 • 開発版"}
        </span>
      </footer>
      {exporting && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>MP4を書き出しています</h2>
            <p>元動画を変更せず、カットと並び順を反映しています。</p>
            <progress max="1" value={progress.progress} />
            <strong>{Math.round(progress.progress * 100)}%</strong>
            <button
              onClick={() =>
                void invoke("cancel_export").catch((e) => setError(message(e)))
              }
            >
              書き出しをキャンセル
            </button>
          </div>
        </div>
      )}
      {progress?.done && !progress.error && (
        <div className="export-result">
          書き出し完了{" "}
          <button
            onClick={() =>
              void invoke("open_output_folder").catch((e) =>
                setError(message(e)),
              )
            }
          >
            保存先フォルダーを開く
          </button>
          <button onClick={() => setProgress(null)}>閉じる</button>
        </div>
      )}
      {recordDialog && (
        <div className="modal-backdrop">
          <div
            className="modal recording-modal"
            role="dialog"
            aria-modal="true"
            aria-label="画面を録画する"
          >
            <h2>画面を録画する</h2>
            {error && (
              <div className="error modal-error" role="alert">
                {error}
              </div>
            )}
            <div
              className={`tool-status ${tools?.ready ? "ready" : "missing"}`}
              role="status"
            >
              {!tools
                ? "FFmpegと録画機能を確認しています…"
                : tools.ready
                  ? "✓ FFmpeg / FFprobe・Windows録画を使用できます"
                  : tools.details}
              {tools?.directory && <small>{tools.directory}</small>}
              {tools && !tools.ready && (
                <p>
                  FFmpegを導入後、ffmpeg.exe と ffprobe.exe のある bin
                  フォルダーを指定してください。PATHに導入した場合はアプリを再起動してください。
                </p>
              )}
              <button disabled={busy} onClick={() => void chooseFFmpeg()}>
                FFmpegのフォルダーを設定
              </button>
            </div>
            <div className="recording-folder">
              <strong>録画の保存先</strong>
              <p>{recordingFolder ?? "未設定 — 初回録画時に選択します"}</p>
              <button
                disabled={busy}
                onClick={() => void changeRecordingFolder()}
              >
                保存先を変更
              </button>
              <small>Rec_01 / Rec_01.mp4 のように連番で保存します。</small>
            </div>
            <label>
              録画する対象
              <select
                disabled={busy}
                value={target?.id ?? ""}
                onChange={(e) =>
                  setTarget(
                    targets.find((t) => t.id === e.target.value) ?? null,
                  )
                }
              >
                <option value="" disabled>
                  録画対象を選択してください
                </option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">
              選択中の対象を赤枠で表示します。赤枠は録画開始前に消えます。最小化されたウィンドウは対象外です。
            </p>
            <button disabled={busy} onClick={() => void refreshTargets()}>
              対象一覧を更新
            </button>
            <button
              disabled={busy}
              onClick={() => void task(() => invoke("select_region"))}
            >
              マウスで範囲を選択
            </button>
            <label className="check">
              <input
                type="checkbox"
                checked={cursor}
                onChange={(e) => setCursor(e.target.checked)}
              />
              マウスカーソルを映す
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={microphone}
                onChange={(e) => setMicrophone(e.target.checked)}
              />
              マイク音声を録音
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={systemAudio}
                onChange={(e) => setSystemAudio(e.target.checked)}
              />
              PC内部音声を録音
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={highlightClicks}
                onChange={(e) => setHighlightClicks(e.target.checked)}
              />
              クリック位置を強調
            </label>
            <label>
              画質
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
              >
                <option value="standard">標準</option>
                <option value="high">高画質</option>
              </select>
            </label>
            <p className="hint">
              30fps / Windowsネイティブ録画
              <br />
              前回の保存先を使用し、3秒で録画を開始します。
              <br />
              音声はWindows WASAPIで録音し、映像と結合します。
              <br />
              ウィンドウ録画中は対象を最小化しないでください。
            </p>
            {count > 0 && <strong className="countdown">{count}</strong>}
            <div className="modal-buttons">
              <button disabled={busy} onClick={() => setRecordDialog(false)}>
                キャンセル
              </button>
              <button
                className="record"
                disabled={busy || !target || !tools?.ready}
                onClick={() => void startRecording()}
              >
                ● 録画開始
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
