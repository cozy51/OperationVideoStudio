import { duration, validateProject, type Media, type Project } from "./editor";
import { clickPoint, outputSize, type ClickInfo } from "./annotations";
import * as ff from "./ffmpeg";

export type Asset = { id: string; png: string };
const IN = "/in";
const encode = [
  "-c:v", "libx264", "-preset", "superfast", "-crf", "20", "-pix_fmt", "yuv420p",
];

export const inputName = (m: Media) =>
  `${m.id}${/\.[a-z0-9]{1,5}$/i.exec(m.name)?.[0].toLowerCase() ?? ".mp4"}`;

/**
 * Builds a single FFmpeg command that cuts, normalizes (output size, 30fps,
 * 48kHz stereo), joins, mixes extra audio and draws overlays in one encode.
 * Encoding once matters in the browser, where FFmpeg runs single-threaded.
 */
export function exportPlan(
  project: Project,
  width: number,
  height: number,
  hasAudio: (m: Media) => boolean,
  output = "output.mp4",
) {
  const total = duration(project.clips);
  const args = ["-hide_banner", "-y"];
  const files: { name: string; asset?: string; text?: string }[] = [];
  let inputs = 0,
    graph = "",
    joined = "";
  const input = (...spec: string[]) => {
    args.push(...spec);
    return inputs++;
  };
  const stereo = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS";
  project.clips.forEach((c, i) => {
    const m = project.media.find((m) => m.id === c.mediaId)!;
    const length = String(c.end - c.start);
    const audio = m.kind !== "gap" && hasAudio(m);
    const video =
      m.kind === "gap"
        ? input("-f", "lavfi", "-t", length, "-i", `color=c=black:s=${width}x${height}:r=30`)
        : input("-ss", String(c.start), "-t", length, "-i", `${IN}/${inputName(m)}`);
    const sound = audio
      ? video
      : input("-f", "lavfi", "-t", length, "-i", "anullsrc=r=48000:cl=stereo");
    // tpad/apad + trim make every segment exactly as long as the clip, so
    // audio and video stay aligned across the joins.
    graph += `[${video}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${length},trim=duration=${length},setpts=PTS-STARTPTS[v${i}];`;
    graph += `[${sound}:a:0]${stereo},apad,atrim=duration=${length},asetpts=PTS-STARTPTS,volume=${c.muted ? 0 : (c.gain ?? 1)}[a${i}];`;
    joined += `[v${i}][a${i}]`;
  });
  graph += `${joined}concat=n=${project.clips.length}:v=1:a=1[vc][ac];`;
  let audioOut = "ac";
  const extra = (project.audio ?? []).filter((a) => !a.muted);
  if (extra.length) {
    let labels = "[ac]";
    extra.forEach((a, index) => {
      const m = project.media.find((m) => m.id === a.mediaId)!;
      const k = input("-ss", String(a.start), "-t", String(a.end - a.start), "-i", `${IN}/${inputName(m)}`);
      graph += `[${k}:a:0]${stereo},volume=${a.gain},adelay=${Math.round(a.at * 1000)}:all=1[voice${index}];`;
      labels += `[voice${index}]`;
    });
    graph += `${labels}amix=inputs=${extra.length + 1}:duration=first:normalize=0,alimiter=level=false[am];`;
    audioOut = "am";
  }
  let current = "vc";
  const annotations = project.annotations ?? [];
  const order = [
    ...annotations.filter((a) => a.kind === "blur" || a.kind === "mosaic"),
    ...annotations.filter((a) => a.kind !== "blur" && a.kind !== "mosaic"),
  ];
  order.forEach((a, index) => {
    const out = `o${index}`;
    const enable = `enable='gte(t,${a.start})*lt(t,${a.end})'`;
    if (a.kind === "blur" || a.kind === "mosaic") {
      const even = (v: number) => Math.floor(v / 2) * 2;
      const x = even(Math.min(Math.floor(a.x * width), width - 2));
      const y = even(Math.min(Math.floor(a.y * height), height - 2));
      const w = even(Math.min(Math.max(Math.floor(a.width * width), 2), width - x));
      const h = even(Math.min(Math.max(Math.floor(a.height * height), 2), height - y));
      const radius = Math.min(10, Math.max(1, Math.floor(Math.min(w, h) / 4)));
      const effect =
        a.kind === "blur"
          ? `boxblur=${radius}:2`
          : `scale=${Math.max(1, Math.floor(w / 16))}:${Math.max(1, Math.floor(h / 16))}:flags=neighbor,scale=${w}:${h}:flags=neighbor`;
      graph += `[${current}]split[b${index}][c${index}];[c${index}]crop=${w}:${h}:${x}:${y},format=rgba,${effect}[mask${index}];[b${index}][mask${index}]overlay=${x}:${y}:${enable}[${out}];`;
    } else {
      const name = `annotation-${index}.png`;
      files.push({ name, asset: a.id });
      const k = input("-loop", "1", "-t", String(total), "-i", name);
      graph += `[${current}][${k}:v]overlay=0:0:${enable}:shortest=1[${out}];`;
    }
    current = out;
  });
  const clicks = project.clicks ?? [];
  if (clicks.length) {
    const side = Math.max(8, Math.round((64 * height) / 1080));
    files.push({ name: "click.png", asset: "__click_marker" });
    const k = input("-loop", "1", "-t", String(total), "-i", "click.png");
    files.push({ name: "clicks.txt", text: clickCommands(project, clicks, width, height, side) });
    graph += `[${current}]sendcmd=f=clicks.txt[clickbase];[clickbase][${k}:v]overlay@cursor=0:0:enable=0:shortest=1[clicked];`;
    current = "clicked";
  }
  graph += `[${current}]format=yuv420p[v]`;
  files.push({ name: "filters.txt", text: graph });
  args.push(
    "-filter_complex_script", "filters.txt",
    "-map", "[v]", "-map", `[${audioOut}]`,
    "-t", String(total),
    ...encode,
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    output,
  );
  return { args, files };
}

function clickCommands(
  project: Project,
  list: ClickInfo[],
  width: number,
  height: number,
  side: number,
) {
  const total = duration(project.clips);
  const clicks = [...list].sort((a, b) => a.time - b.time);
  let commands = "";
  clicks.forEach((click, index) => {
    const [px, py] = clickPoint(click, project.media, width, height);
    const end = Math.min(click.time + 0.4, total);
    commands += `${click.time} overlay@cursor x ${Math.round(px - side / 2)}, overlay@cursor y ${Math.round(py - side / 2)}, overlay@cursor enable 1;\n`;
    if (!clicks[index + 1] || clicks[index + 1].time >= end)
      commands += `${end} overlay@cursor enable 0;\n`;
  });
  return commands;
}

const decode = (base64: string) =>
  Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

export class ExportCancelled extends Error {
  constructor() {
    super("書き出しをキャンセルしました");
  }
}

/** Renders the project to an MP4 inside the browser. */
export async function renderProject(
  input: Project,
  resolution: string,
  assets: Asset[],
  files: (m: Media) => Blob | undefined,
  progress: (ratio: number) => void,
  cancelled: () => boolean,
): Promise<Blob> {
  const project = validateProject(input);
  if (!project.clips.length) throw new Error("書き出すクリップがありません");
  const first = project.media.find((m) => m.id === project.clips[0].mediaId);
  const [width, height] = outputSize(first, resolution);
  const total = duration(project.clips);
  const used = project.media.filter(
    (m) =>
      m.kind !== "gap" &&
      (project.clips.some((c) => c.mediaId === m.id) ||
        (project.audio ?? []).some((a) => a.mediaId === m.id)),
  );
  const blobs = used.map((m) => {
    const data = files(m);
    if (!data) throw new Error(`動画ファイルが見つかりません: ${m.name}`);
    return { name: inputName(m), data };
  });
  const check = () => {
    if (cancelled()) throw new ExportCancelled();
  };
  const step = async (args: string[], start: number, weight: number, length: number) => {
    check();
    const { code, log } = await ff.run(args, (t) =>
      progress(start + weight * Math.min(1, Math.max(0, t / length))),
    );
    check();
    if (code !== 0)
      throw new Error(
        `動画処理に失敗しました。形式を確認してください。\n${log.slice(-8).join("\n")}`,
      );
  };
  await ff.loadFFmpeg();
  const release = await ff.mountInputs(IN, blobs);
  const written: string[] = [];
  try {
    const audio = new Map<string, boolean>();
    for (const m of used) {
      const { log } = await ff.run(["-hide_banner", "-i", `${IN}/${inputName(m)}`]);
      const info = ff.parseProbe(log);
      if (!info) throw new Error(`動画を読み込めません: ${m.name}`);
      if (Number.isFinite(info.duration) && project.clips.some((c) => c.mediaId === m.id && c.end > info.duration + 0.05))
        throw new Error(`動画の長さが変わっています: ${m.name}`);
      audio.set(m.id, info.hasAudio);
    }
    const plan = exportPlan(project, width, height, (m) => audio.get(m.id) ?? false);
    for (const f of plan.files) {
      written.push(f.name);
      if (f.text !== undefined) await ff.writeFile(f.name, f.text);
      else {
        const asset = assets.find((a) => a.id === f.asset);
        if (!asset) throw new Error("注釈画像が不足しています");
        await ff.writeFile(f.name, decode(asset.png));
      }
    }
    const rendered = plan.args[plan.args.length - 1];
    written.push(rendered);
    await step(plan.args, 0.02, 0.97, total);
    const data = await ff.readFile(rendered);
    progress(1);
    return new Blob([data as BlobPart], { type: "video/mp4" });
  } finally {
    if (!cancelled()) {
      for (const name of written) await ff.removeFile(name);
      await release();
    }
  }
}
