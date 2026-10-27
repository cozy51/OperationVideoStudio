import { validateProject, type Media, type Project } from "./editor";
import type { ClickInfo } from "./annotations";
import * as ff from "./ffmpeg";
import { ExportCancelled, renderProject, type Asset } from "./exporter";
import type { RecordingResult } from "./recorder";

// Video files never leave the browser. They are kept in memory while the page
// is open and in IndexedDB so that autosave/recovery and reopening a project
// in the same browser work without selecting the files again.
const files = new Map<string, Blob>();
const urls = new Map<string, string>();

export function mediaUrl(m: Media) {
  let url = urls.get(m.id);
  const file = files.get(m.id);
  if (!url && file) {
    url = URL.createObjectURL(file);
    urls.set(m.id, url);
  }
  return url ?? "";
}

function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open("operation-video-studio", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("files");
      request.result.createObjectStore("state");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}
async function store<T>(
  name: "files" | "state",
  mode: IDBTransactionMode,
  action: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  const db = await database();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const request = action(db.transaction(name, mode).objectStore(name));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function remember(id: string, file: Blob) {
  files.set(id, file);
  await store("files", "readwrite", (s) => s.put(file, id)).catch(() => {});
}
async function restore(id: string) {
  const known = files.get(id);
  if (known) return known;
  const file = await store<Blob>("files", "readonly", (s) => s.get(id)).catch(
    () => undefined,
  );
  if (file) files.set(id, file);
  return file;
}

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

const videoExtensions = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
export async function addFiles(list: File[]): Promise<Media[]> {
  const videos = list.filter(
    (f) => f.type.startsWith("video/") || videoExtensions.test(f.name),
  );
  if (!videos.length) throw new Error("動画ファイルを選択してください。");
  const media: Media[] = [];
  for (const file of videos) {
    const info = await ff.probe(`input${/\.[^.]+$/.exec(file.name)?.[0] ?? ""}`, file);
    const duration = Number.isFinite(info.duration)
      ? info.duration
      : await playableDuration(file);
    const m: Media = {
      id: crypto.randomUUID(),
      path: file.name,
      name: file.name,
      duration,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
      codec: info.codec,
    };
    await remember(m.id, file);
    media.push(m);
  }
  return media;
}

export async function importVideos() {
  const list = await pickFiles("video/*,.mkv,.mov,.avi", true);
  return list.length ? addFiles(list) : [];
}

/** Duration via the media element, for files whose header has none. */
function playableDuration(file: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (value: number | Error) => {
      URL.revokeObjectURL(url);
      value instanceof Error ? reject(value) : resolve(value);
    };
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration)) return done(v.duration);
      v.ondurationchange = () => {
        if (Number.isFinite(v.duration)) done(v.duration);
      };
      v.currentTime = 1e101;
    };
    v.onerror = () => done(new Error("動画の長さを取得できません"));
    v.src = url;
  });
}

export function recordingName(project: Project) {
  const used = new Set(
    project.media.map((m) => /^Rec_(\d+)\./.exec(m.name)?.[1]).filter(Boolean).map(Number),
  );
  let n = 1;
  while (used.has(n)) n++;
  return `Rec_${String(n).padStart(2, "0")}`;
}

/** Rewrites the recorder's streaming output so that it has a duration and seek index. */
export async function addRecording(
  project: Project,
  result: RecordingResult,
): Promise<Media & { clicks?: ClickInfo[] }> {
  const name = `${recordingName(project)}.${result.extension}`;
  let blob = result.blob;
  try {
    const release = await ff.mountInputs("/rec", [{ name: `raw.${result.extension}`, data: blob }]);
    try {
      const out = `recording.${result.extension}`;
      const { code } = await ff.run([
        "-hide_banner", "-y", "-i", `/rec/raw.${result.extension}`, "-c", "copy",
        ...(result.extension === "mp4" ? ["-movflags", "+faststart"] : []),
        out,
      ]);
      if (code === 0) {
        blob = new Blob([(await ff.readFile(out)) as BlobPart], { type: blob.type });
        await ff.removeFile(out);
      }
    } finally {
      await release();
    }
  } catch {
    // Keep the original recording; it is still playable, only seeking is slower.
  }
  let info: ff.ProbeInfo | null = null;
  try {
    info = await ff.probe(name, blob);
  } catch {
    info = null;
  }
  const m: Media = {
    id: crypto.randomUUID(),
    path: name,
    name,
    duration:
      info && Number.isFinite(info.duration) && info.duration > 0
        ? info.duration
        : Math.max(0.1, result.seconds),
    width: info?.width ?? screen.width * devicePixelRatio,
    height: info?.height ?? screen.height * devicePixelRatio,
    hasAudio: info?.hasAudio ?? result.hasAudio,
    codec: info?.codec,
  };
  await remember(m.id, blob);
  return m;
}

async function saveBlob(blob: Blob, name: string, handle?: FileSystemFileHandle | null) {
  if (handle) {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

type Picker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;
/** Returns undefined when the user cancels, null when the browser has no save dialog. */
async function chooseSaveFile(name: string, description: string, mime: string, ext: string) {
  const picker = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
  if (!picker) return null;
  try {
    return await picker({
      suggestedName: name,
      types: [{ description, accept: { [mime]: [ext] } }],
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return undefined;
    throw e;
  }
}

export async function saveProject(project: Project) {
  const handle = await chooseSaveFile("project.ovs.json", "プロジェクト", "application/json", ".json");
  if (handle === undefined) return false;
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  await saveBlob(blob, "project.ovs.json", handle);
  return true;
}

/** Opens a project JSON. Videos are taken from this browser's storage or from files selected with it. */
export async function openProject(): Promise<Project | null> {
  const list = await pickFiles("application/json,.json,video/*,.mkv,.mov,.avi", true);
  if (!list.length) return null;
  const json = list.find((f) => /\.json$/i.test(f.name));
  if (!json) throw new Error("プロジェクトファイル（.json）を選択してください。");
  const project = validateProject(JSON.parse(await json.text()));
  const missing: string[] = [];
  for (const m of project.media) {
    if (m.kind === "gap" || (await restore(m.id))) continue;
    const file = list.find((f) => f.name === m.name || f.name === m.path.split(/[\\/]/).pop());
    if (file) await remember(m.id, file);
    else missing.push(m.name);
  }
  if (missing.length)
    throw new Error(
      `次の動画が見つかりません。プロジェクトファイルと一緒に選択してください: ${missing.join("、")}`,
    );
  return project;
}

export async function autosave(project: Project) {
  await store("state", "readwrite", (s) => s.put(project, "autosave"));
  const keep = new Set(project.media.map((m) => m.id));
  const keys = (await store("files", "readonly", (s) => s.getAllKeys())) ?? [];
  for (const key of keys)
    if (!keep.has(String(key)) && !files.has(String(key)))
      await store("files", "readwrite", (s) => s.delete(key));
}

export async function recoverProject(): Promise<Project | null> {
  const saved = await store<Project>("state", "readonly", (s) => s.get("autosave")).catch(
    () => undefined,
  );
  if (!saved?.clips?.length) return null;
  const project = validateProject(saved);
  for (const m of project.media)
    if (m.kind !== "gap" && !(await restore(m.id))) return null;
  return project;
}

let cancelRequested = false;
export function cancelExport() {
  cancelRequested = true;
  ff.terminateFFmpeg();
}

/** Returns false when the user cancels the save dialog. */
export async function exportVideo(
  project: Project,
  resolution: string,
  assets: Asset[],
  progress: (ratio: number) => void,
) {
  const d = new Date();
  const stamp = [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]
    .map((n) => String(n).padStart(2, "0"))
    .join("");
  const name = `operation-video-${stamp}.mp4`;
  const handle = await chooseSaveFile(name, "MP4 動画", "video/mp4", ".mp4");
  if (handle === undefined) return false;
  cancelRequested = false;
  try {
    const blob = await renderProject(
      project,
      resolution,
      assets,
      (m) => files.get(m.id),
      progress,
      () => cancelRequested,
    );
    await saveBlob(blob, name, handle);
    return true;
  } catch (e) {
    if (cancelRequested) throw new ExportCancelled();
    throw e;
  }
}
