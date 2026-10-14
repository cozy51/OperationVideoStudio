// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "recover_project") return null;
    if (
      command === "show_capture_outline" ||
      command === "hide_capture_outline"
    )
      return null;
    if (command === "open_project") return structuredClone(project);
    if (command === "autosave") return null;
    if (command === "save_project") return true;
    throw new Error(command);
  });
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
  const saved = vi
    .mocked(invoke)
    .mock.calls.find(([c]) => c === "save_project")?.[1] as {
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
  const saved = vi
    .mocked(invoke)
    .mock.calls.find(([c]) => c === "save_project")?.[1] as {
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
  const saved = vi
    .mocked(invoke)
    .mock.calls.find(([c]) => c === "save_project")?.[1] as {
    project: typeof project;
  };
  expect(saved.project.clips.map((c) => c.id)).toEqual(["b", "a"]);
  Reflect.deleteProperty(document, "elementFromPoint");
  Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  vi.unstubAllGlobals();
});

it("素材のクリックはプレビューだけを行い、ダブルクリックで一度だけ追加する", async () => {
  const sourceProject = { ...structuredClone(project), clips: [] };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "recover_project") return null;
    if (command === "open_project") return sourceProject;
    if (command === "save_project") return true;
    if (command === "autosave") return null;
    throw new Error(command);
  });
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
  const saved = vi
    .mocked(invoke)
    .mock.calls.find(([c]) => c === "save_project")?.[1] as {
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
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "recover_project") return null;
    if (command === "open_project") return edited;
    if (command === "autosave") return null;
    if (command === "save_project") return true;
    throw new Error(command);
  });
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
  const saved = vi
    .mocked(invoke)
    .mock.calls.find(([c]) => c === "save_project")?.[1] as {
    project: typeof edited;
  };
  expect(saved.project.clips).toEqual(edited.clips);
});
