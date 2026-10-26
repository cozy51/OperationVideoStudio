// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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
const project = {
  version: 1,
  media: [
    {
      id: "m",
      path: "C:/Rec_01.mp4",
      name: "Rec_01.mp4",
      duration: 10,
      width: 1920,
      height: 1080,
      hasAudio: false,
    },
  ],
  clips: [
    { id: "a", mediaId: "m", start: 0, end: 4 },
    { id: "b", mediaId: "m", start: 6, end: 10 },
  ],
};
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  mockPlatform(structuredClone(project));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("分割クリップだけの表示名を変更し、JSON保存・Undoに反映する", async () => {
  render(<App />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "プロジェクトを開く" }));
  await user.click(
    await screen.findByRole("button", { name: "クリップ 1: Rec_01.mp4" }),
  );
  const input = screen.getByLabelText("クリップ名");
  await user.clear(input);
  await user.type(input, "設定を確認{Enter}");
  expect(
    screen.getByRole("button", { name: "クリップ 1: 設定を確認" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "クリップ 2: Rec_01.mp4" }),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "保存" }));
  const saved = savedProject() as unknown as {
    project: typeof project & { clips: { name?: string }[] };
  };
  expect(saved.project.clips[0].name).toBe("設定を確認");
  expect(saved.project.media[0].name).toBe("Rec_01.mp4");
  expect(saved.project.media[0].path).toBe("C:/Rec_01.mp4");
  await user.click(screen.getByRole("button", { name: "↶ 元に戻す" }));
  expect(
    screen.getByRole("button", { name: "クリップ 1: Rec_01.mp4" }),
  ).toBeTruthy();
});
it("ドラッグを使わず左右ボタンで並べ替え、元に戻せる", async () => {
  render(<App />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "プロジェクトを開く" }));
  await user.click(
    await screen.findByRole("button", { name: "クリップ 1: Rec_01.mp4" }),
  );
  expect(
    (screen.getByRole("button", { name: "← 左へ移動" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "右へ移動 →" }));
  await user.click(screen.getByRole("button", { name: "保存" }));
  const saved = savedProject() as unknown as {
    project: typeof project;
  };
  expect(saved.project.clips.map((c) => c.id)).toEqual(["b", "a"]);
  await user.click(screen.getByRole("button", { name: "↶ 元に戻す" }));
  expect(
    (screen.getByRole("button", { name: "← 左へ移動" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("クリップのつかみ部分を移動先へドラッグすると順序を変更する", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => {},
  });
  render(<App />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "プロジェクトを開く" }));
  const first = await screen.findByRole("button", {
    name: "クリップ 1: Rec_01.mp4",
  });
  const second = screen.getByRole("button", { name: "クリップ 2: Rec_01.mp4" });
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => second,
  });
  const grip = first.querySelector(".clip-grip")!;
  fireEvent.pointerDown(grip, { clientX: 10, clientY: 10, pointerId: 1 });
  fireEvent.pointerMove(grip, { clientX: 100, clientY: 10, pointerId: 1 });
  fireEvent.pointerUp(grip, { clientX: 100, clientY: 10, pointerId: 1 });
  await user.click(screen.getByRole("button", { name: "保存" }));
  const saved = savedProject() as unknown as {
    project: typeof project;
  };
  expect(saved.project.clips.map((c) => c.id)).toEqual(["b", "a"]);
  Reflect.deleteProperty(document, "elementFromPoint");
  Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  vi.unstubAllGlobals();
});

it("素材のクリックはプレビューだけを行い、ダブルクリックで一度だけ追加する", async () => {
  const sourceProject = { ...structuredClone(project), clips: [] };
  mockPlatform(sourceProject);
  render(<App />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "プロジェクトを開く" }));
  const source = await screen.findByRole("button", { name: "素材 Rec_01.mp4" });
  await user.click(source);
  expect(
    screen.getByRole("heading", { name: "素材確認：Rec_01.mp4" }),
  ).toBeTruthy();
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "クリップ 1: Rec_01.mp4" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存" }));
  const saved = savedProject() as unknown as {
    project: typeof sourceProject;
  };
  expect(saved.project.clips).toHaveLength(0);
  await user.dblClick(source);
  expect(
    screen.getByRole("button", { name: "クリップ 1: Rec_01.mp4" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "クリップ 2: Rec_01.mp4" }),
  ).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "素材確認：Rec_01.mp4" }),
  ).toBeNull();
});

it("素材の再生位置を変えても編集タイムラインの位置と内容を保つ", async () => {
  const edited = {
    ...structuredClone(project),
    clips: [
      { id: "a", mediaId: "m", start: 2, end: 4 },
      { id: "b", mediaId: "m", start: 6, end: 10 },
    ],
  };
  mockPlatform(edited);
  render(<App />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "プロジェクトを開く" }));
  await user.click(
    await screen.findByRole("button", { name: "素材 Rec_01.mp4" }),
  );
  const video = document.querySelector("video")!;
  video.currentTime = 8;
  fireEvent.timeUpdate(video);
  expect(
    (screen.getByLabelText("再生位置（秒）") as HTMLInputElement).value,
  ).toBe("0");
  await user.click(screen.getByRole("button", { name: "編集結果へ戻る" }));
  expect(video.currentTime).toBe(2);
  await user.click(screen.getByRole("button", { name: "保存" }));
  const saved = savedProject() as unknown as {
    project: typeof edited;
  };
  expect(saved.project.clips).toEqual(edited.clips);
});
