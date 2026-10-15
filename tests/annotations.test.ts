import { describe, expect, it } from "vitest";
import { resizeAnnotation } from "../src/AnnotationEditor";
import {
  newAnnotation,
  validateAnnotation,
  clickPoint,
} from "../src/annotations";
import { cutProject, validateProject, type Project } from "../src/editor";
const media = {
  id: "m",
  path: "source.mp4",
  name: "source.mp4",
  duration: 30,
  width: 1920,
  height: 1080,
  hasAudio: false,
};
it("注釈の時間を区間削除に追従させる", () => {
  const a = newAnnotation("text", 8, 30);
  a.end = 18;
  const p: Project = {
    version: 2,
    media: [media],
    clips: [{ id: "c", mediaId: "m", start: 0, end: 30 }],
    annotations: [a],
    clicks: [
      { time: 12, x: 0.5, y: 0.5, mediaId: "m" },
      { time: 21, x: 0.5, y: 0.5, mediaId: "m" },
    ],
  };
  const cut = cutProject(p, 10, 15);
  expect(cut.annotations?.[0].start).toBe(8);
  expect(cut.annotations?.[0].end).toBe(13);
  expect(cut.clicks?.map((c) => c.time)).toEqual([16]);
  expect(validateProject(cut)).toBe(cut);
});
it("完全に削除した区間内の注釈を残さない", () => {
  const a = newAnnotation("rectangle", 11, 30);
  a.end = 14;
  const p: Project = {
    version: 2,
    media: [media],
    clips: [{ id: "c", mediaId: "m", start: 0, end: 30 }],
    annotations: [a],
  };
  expect(cutProject(p, 10, 15).annotations).toEqual([]);
});
it("注釈の異常値と画面外の範囲を拒否する", () => {
  const a = newAnnotation("text", 0, 10);
  expect(validateAnnotation(a, 10)).toBe(true);
  expect(validateAnnotation({ ...a, x: 1 }, 10)).toBe(false);
  expect(validateAnnotation({ ...a, end: NaN }, 10)).toBe(false);
  expect(validateAnnotation({ ...a, color: "red;file=private" }, 10)).toBe(
    false,
  );
});
it("縦動画のクリック座標を出力の余白に合わせる", () => {
  expect(
    clickPoint(
      { time: 0, x: 0.5, y: 0.5, mediaId: "v" },
      [{ id: "v", width: 1080, height: 1920 }],
      1920,
      1080,
    ),
  ).toEqual([960, 540]);
});
describe("resizeAnnotation", () => {
  const a = newAnnotation("rectangle", 0, 10);
  it("横と縦を独立して変更できる", () => {
    const wider = resizeAnnotation(a, "e", 0.1, 0.3);
    expect(wider.width).toBeCloseTo(a.width + 0.1);
    expect(wider.height).toBe(a.height);
    const taller = resizeAnnotation(a, "s", 0.3, 0.1);
    expect(taller.height).toBeCloseTo(a.height + 0.1);
    expect(taller.width).toBe(a.width);
  });
  it("左上の角では反対側の辺を固定したまま縮める", () => {
    const r = resizeAnnotation(a, "nw", 0.05, 0.05);
    expect(r.x + r.width).toBeCloseTo(a.x + a.width);
    expect(r.y + r.height).toBeCloseTo(a.y + a.height);
    expect(r.width).toBeCloseTo(a.width - 0.05);
  });
  it("画面外や最小サイズ未満にはならない", () => {
    const r = resizeAnnotation(a, "se", 5, 5);
    expect(r.x + r.width).toBeCloseTo(1);
    expect(r.y + r.height).toBeCloseTo(1);
    const tiny = resizeAnnotation(a, "w", 5, 0);
    expect(tiny.width).toBeCloseTo(0.01);
    expect(resizeAnnotation(a, "", -5, -5)).toMatchObject({ x: 0, y: 0 });
  });
});
