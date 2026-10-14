import { describe, expect, it } from "vitest";
import {
  cutRange,
  duration,
  locate,
  moveClip,
  split,
  validateProject,
  type Clip,
} from "../src/editor";
const clips: Clip[] = [
  { id: "a", mediaId: "one", start: 0, end: 30 },
  { id: "b", mediaId: "two", start: 2, end: 12 },
];
describe("非破壊タイムライン", () => {
  it("30秒動画の中間5秒を削除し、別動画と35秒に連結する", () => {
    const result = cutRange(clips, 10, 15);
    expect(result.map((c) => [c.mediaId, c.start, c.end])).toEqual([
      ["one", 0, 10],
      ["one", 15, 30],
      ["two", 2, 12],
    ]);
    expect(duration(result)).toBe(35);
    expect(clips[0].end).toBe(30);
  });
  it("複数クリップをまたぐ削除を詰める", () => {
    expect(cutRange(clips, 25, 35).map((c) => [c.start, c.end])).toEqual([
      [0, 25],
      [7, 12],
    ]);
  });
  it("分割後も元動画の参照時刻を維持する", () => {
    const result = split(clips, 33);
    expect(result.slice(1).map((c) => [c.start, c.end])).toEqual([
      [2, 5],
      [5, 12],
    ]);
    expect(locate(result, 33)?.sourceTime).toBe(5);
  });
  it("境界の分割では空クリップを作らない", () => {
    expect(split(clips, 30)).toBe(clips);
    expect(split(clips, 0)).toBe(clips);
  });
  it("並べ替えで動画の順序だけを変える", () => {
    expect(moveClip(clips, 0, 1).map((c) => c.id)).toEqual(["b", "a"]);
  });
  it("負数と不正なプロジェクトを拒否する", () => {
    expect(cutRange(clips, -1, 4)).toBe(clips);
    expect(() => validateProject({ version: 1, media: [], clips })).toThrow();
  });
});
