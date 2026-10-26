// @vitest-environment jsdom
import React from "react";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as platform from "../src/platform";
import { App } from "../src/App";
vi.mock("../src/platform", () => ({
  mediaUrl: (m: { path: string }) => m.path,
  recoverProject: vi.fn(),
  autosave: vi.fn(),
  openProject: vi.fn(),
  saveProject: vi.fn(),
  importVideos: vi.fn(),
  addFiles: vi.fn(),
  addRecording: vi.fn(),
  exportVideo: vi.fn(),
  cancelExport: vi.fn(),
}));
const savedProject = () => ({
  project: vi.mocked(platform.saveProject).mock.calls.at(-1)![0],
});
function mockPlatform(opened: unknown) {
  vi.mocked(platform.recoverProject).mockReset().mockResolvedValue(null);
  vi.mocked(platform.autosave).mockReset().mockResolvedValue();
  vi.mocked(platform.saveProject).mockReset().mockResolvedValue(true);
  vi.mocked(platform.openProject)
    .mockReset()
    .mockImplementation(async () => structuredClone(opened) as never);
}
const source = {
  id: "m",
  path: "C:/source.mp4",
  name: "source.mp4",
  duration: 10,
  width: 1920,
  height: 1080,
  hasAudio: true,
};
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const ctx = {
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillText: vi.fn(),
    measureText: () => ({ width: 10 }),
    ellipse: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
  mockPlatform({
        version: 1,
        media: [source],
        clips: [{ id: "c", mediaId: "m", start: 0, end: 10 }],
      });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("時刻付きコメントを追加・編集・複製し、元動画参照と一緒に保存できる", async () => {
  render(<App />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "プロジェクトを開く" }));
  await user.click(await screen.findByRole("button", { name: "テキスト" }));
  const text = screen.getByLabelText("文字");
  await user.clear(text);
  await user.type(text, "ここをクリック");
  await user.click(screen.getByRole("button", { name: "複製" }));
  await user.click(screen.getByRole("button", { name: "保存" }));
  const saved = savedProject() as unknown as {
    project: {
      version: number;
      annotations: { text: string; start: number; end: number; id: string }[];
    };
  };
  expect(saved.project.version).toBe(2);
  expect(saved.project.annotations).toHaveLength(2);
  expect(saved.project.annotations[0].text).toBe("ここをクリック");
  expect(saved.project.annotations[0].start).toBe(0);
  expect(saved.project.annotations[0].end).toBe(3);
  expect(saved.project.annotations[0].id).not.toBe(
    saved.project.annotations[1].id,
  );
  await user.click(screen.getByRole("button", { name: "注釈を削除" }));
  expect(screen.queryByRole("button", { name: "注釈を削除" })).toBeNull();
});
it("黒画面・無音素材を追加しても実ファイル参照を作らない", async () => {
  render(<App />);
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "黒画面・無音を末尾に追加" }),
  );
  await user.click(screen.getByRole("button", { name: "保存" }));
  const saved = savedProject() as unknown as {
    project: { media: { kind: string; path: string }[]; clips: unknown[] };
  };
  expect(saved.project.media[0].kind).toBe("gap");
  expect(saved.project.media[0].path).toBe("");
  expect(saved.project.clips).toHaveLength(1);
});
it("素材の音声だけを別トラックに追加して保存できる", async () => {
  render(<App />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "プロジェクトを開く" }));
  await user.click(
    await screen.findByRole("button", { name: "素材 source.mp4" }),
  );
  await user.click(
    screen.getByRole("button", { name: "この素材の音声だけを追加" }),
  );
  await user.click(screen.getByRole("button", { name: "保存" }));
  const saved = savedProject() as unknown as {
    project: {
      audio: { mediaId: string; at: number; start: number; end: number }[];
      clips: unknown[];
    };
  };
  expect(saved.project.audio).toHaveLength(1);
  expect(saved.project.audio[0]).toMatchObject({
    mediaId: "m",
    at: 0,
    start: 0,
    end: 10,
  });
  expect(saved.project.clips).toHaveLength(1);
});
it("注釈バーをダブルクリックすると文字欄で編集でき、改行も入力できる", async () => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  render(<App />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "プロジェクトを開く" }));
  await user.click(await screen.findByRole("button", { name: "テキスト" }));
  await user.dblClick(screen.getByTitle("ダブルクリックで文字を編集"));
  const text = screen.getByLabelText("文字");
  expect(document.activeElement).toBe(text);
  await user.keyboard("一行目{Enter}二行目");
  expect((text as HTMLTextAreaElement).value).toBe("一行目\n二行目");
});
