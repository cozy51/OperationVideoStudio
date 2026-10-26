import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";

// ffmpeg.wasm runs FFmpeg inside a Web Worker. The core is served from this
// site (bundled by Vite), so no video data or code is fetched from elsewhere.
let instance: Promise<FFmpeg> | null = null;
let logListener: ((line: string) => void) | null = null;

export function loadFFmpeg() {
  if (!instance) {
    const ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => logListener?.(message));
    instance = ffmpeg
      // The single-threaded core: the multi-threaded build of 0.12 crashes
      // with libx264 and needs cross-origin isolation.
      .load({ coreURL, wasmURL })
      .then(() => ffmpeg)
      .catch((e) => {
        instance = null;
        throw new Error(`動画処理エンジンを読み込めません: ${String(e)}`);
      });
  }
  return instance;
}

/** Stops a running job. The next call to loadFFmpeg starts a fresh worker. */
export function terminateFFmpeg() {
  const current = instance;
  instance = null;
  void current?.then((f) => f.terminate()).catch(() => {});
}

export interface RunResult {
  code: number;
  log: string[];
}

/** Runs one FFmpeg command, reporting the latest `time=` position in seconds. */
export async function run(
  args: string[],
  onTime?: (seconds: number) => void,
): Promise<RunResult> {
  const ffmpeg = await loadFFmpeg();
  const log: string[] = [];
  logListener = (line) => {
    log.push(line);
    if (log.length > 400) log.shift();
    const m = /time=(-?\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (m && onTime) onTime(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
  };
  try {
    const code = await ffmpeg.exec(args);
    return { code, log };
  } finally {
    logListener = null;
  }
}

export async function mountInputs(
  dir: string,
  blobs: { name: string; data: Blob }[],
) {
  const ffmpeg = await loadFFmpeg();
  await ffmpeg.createDir(dir).catch(() => {});
  await ffmpeg.mount(FFFSType.WORKERFS, { blobs }, dir);
  return () => ffmpeg.unmount(dir).then(() => ffmpeg.deleteDir(dir)).catch(() => {});
}

export async function writeFile(path: string, data: Uint8Array | string) {
  await (await loadFFmpeg()).writeFile(path, data);
}

export async function readFile(path: string) {
  const data = await (await loadFFmpeg()).readFile(path);
  if (typeof data === "string") throw new Error("出力を読み込めません");
  return data;
}

export async function removeFile(path: string) {
  await (await loadFFmpeg()).deleteFile(path).catch(() => {});
}

export interface ProbeInfo {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  codec?: string;
}

/** Parses the stream summary FFmpeg prints for `-i <file>`. */
export function parseProbe(log: string[]): ProbeInfo | null {
  let duration = NaN,
    width = 0,
    height = 0,
    hasAudio = false,
    codec: string | undefined;
  for (const line of log) {
    const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (d) duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
    const v = /Stream #\d+:\d+.*?: Video: (\w+).*?, (\d{2,5})x(\d{2,5})/.exec(line);
    if (v && !width) {
      codec = v[1];
      width = Number(v[2]);
      height = Number(v[3]);
    }
    if (/Stream #\d+:\d+.*?: Audio: /.test(line)) hasAudio = true;
  }
  if (!width || !height) return null;
  return { duration, width, height, hasAudio, codec };
}

export async function probe(name: string, data: Blob): Promise<ProbeInfo> {
  const release = await mountInputs("/probe", [{ name, data }]);
  try {
    const { log } = await run(["-hide_banner", "-i", `/probe/${name}`]);
    const info = parseProbe(log);
    if (!info) throw new Error(`映像を含む動画ではありません: ${name}`);
    return info;
  } finally {
    await release();
  }
}
