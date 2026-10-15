// @vitest-environment jsdom
import React from "react";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { App } from "../src/App";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
  convertFileSrc: (s: string) => s,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
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
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "recover_project") return null;
    if (command === "open_project")
      return {
        version: 1,
        media: [source],
        clips: [{ id: "c", mediaId: "m", start: 0, end: 10 }],
      };
    if (command === "save_project") return true;
    if (command === "autosave") return null;
    throw new Error(command);
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
  const saved = vi
    .mocked(invoke)
    .mock.calls.find(([c]) => c === "save_project")?.[1] as {
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
  const saved = vi
    .mocked(invoke)
    .mock.calls.find(([c]) => c === "save_project")?.[1] as {
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
  const saved = vi
    .mocked(invoke)
    .mock.calls.find(([c]) => c === "save_project")?.[1] as {
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
