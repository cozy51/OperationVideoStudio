import { expect, it } from "vitest";
import { exportPlan, inputName } from "../src/exporter";
import { parseProbe } from "../src/ffmpeg";
import { newAnnotation } from "../src/annotations";
import type { Project } from "../src/editor";

const project: Project = {
  version: 2,
  media: [
    { id: "m", path: "a.webm", name: "Rec_01.webm", duration: 10, width: 1280, height: 720, hasAudio: true },
    { id: "g", kind: "gap", path: "", name: "黒画面", duration: 2, width: 1920, height: 1080, hasAudio: false },
  ],
  clips: [
    { id: "a", mediaId: "m", start: 1.5, end: 4, gain: 0.5 },
    { id: "b", mediaId: "g", start: 0, end: 2 },
  ],
};

const graphOf = (plan: ReturnType<typeof exportPlan>) =>
  plan.files.find((f) => f.name === "filters.txt")!.text!;

it("クリップを切り出し、出力サイズ・30fps・48kHzに揃えて1回でつなぐ", () => {
  const plan = exportPlan(project, 1920, 1080, () => true);
  expect(plan.args.slice(2, 8)).toEqual(["-ss", "1.5", "-t", "2.5", "-i", "/in/m.webm"]);
  expect(plan.args).toContain("color=c=black:s=1920x1080:r=30");
  const graph = graphOf(plan);
  expect(graph).toContain("[0:v:0]scale=1920:1080:force_original_aspect_ratio=decrease");
  expect(graph).toContain("trim=duration=2.5");
  expect(graph).toContain("volume=0.5[a0]");
  expect(graph).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][ac]");
  expect(plan.args.filter((a) => a === "libx264")).toHaveLength(1);
  expect(plan.args.at(-1)).toBe("output.mp4");
});

it("音声のない素材と黒画面には無音を合成する", () => {
  const graph = graphOf(exportPlan(project, 1280, 720, () => false));
  expect(graph).toContain("[1:a:0]");
  expect(graph).toContain("[3:a:0]");
  const args = exportPlan(project, 1280, 720, () => false).args;
  expect(args.filter((a) => a === "anullsrc=r=48000:cl=stereo")).toHaveLength(2);
});

it("追加音声は消音を除いて配置時刻どおりに重ねる", () => {
  expect(graphOf(exportPlan(project, 1920, 1080, () => true))).not.toContain("amix");
  const plan = exportPlan(
    {
      ...project,
      audio: [
        { id: "x", mediaId: "m", start: 1, end: 2, at: 0.5, gain: 0.8, muted: false },
        { id: "y", mediaId: "m", start: 0, end: 1, at: 0, gain: 1, muted: true },
      ],
    },
    1920,
    1080,
    () => true,
  );
  const graph = graphOf(plan);
  expect(graph).toContain("adelay=500:all=1");
  expect(graph).toContain("amix=inputs=2");
  expect(plan.args).toContain("[am]");
});

it("ぼかしを先に、注釈画像を後に重ね、表示時間を指定する", () => {
  const text = { ...newAnnotation("text", 0, 4.5), id: "t" };
  const blur = { ...newAnnotation("blur", 1, 4.5), id: "b" };
  const plan = exportPlan({ ...project, annotations: [text, blur] }, 1920, 1080, () => true);
  const graph = graphOf(plan);
  expect(graph.indexOf("boxblur")).toBeLessThan(graph.indexOf("[3:v]overlay"));
  expect(graph).toContain("enable='gte(t,0)*lt(t,3)'");
  expect(plan.files).toContainEqual({ name: "annotation-1.png", asset: "t" });
  expect(plan.args).toContain("-filter_complex_script");
});

it("入力ファイル名は素材IDと拡張子から作る", () => {
  expect(inputName(project.media[0])).toBe("m.webm");
  expect(inputName({ ...project.media[0], name: "録画" })).toBe("m.mp4");
});

it("FFmpegの出力から長さ・解像度・音声の有無を読み取る", () => {
  expect(
    parseProbe([
      "  Duration: 00:01:02.50, start: 0.000000, bitrate: 900 kb/s",
      "  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 30 fps",
      "  Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo",
    ]),
  ).toEqual({ duration: 62.5, width: 1920, height: 1080, hasAudio: true, codec: "h264" });
  expect(parseProbe(["  Duration: N/A, start: 0.000000", "  Stream #0:0: Audio: opus"])).toBeNull();
});
