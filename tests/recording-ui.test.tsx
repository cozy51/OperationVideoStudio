// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { App } from "../src/App";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
const target = {
  id: "desktop",
  name: "デスクトップ全体",
  kind: "desktop",
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
};
const missing = {
  ready: false,
  details: "FFmpegが見つかりません。bin フォルダーを選択してください。",
  directory: null,
};
const ready = {
  ready: true,
  details: "ffmpeg version test",
  directory: "C:\\tools\\ffmpeg\\bin",
};
const commands = vi.mocked(invoke);
beforeEach(() => {
  commands.mockReset();
  commands.mockImplementation(async (command) => {
    if (command === "recover_project") return null;
    if (command === "capture_targets") return [target];
    if (command === "recording_tools") return missing;
    if (command === "choose_ffmpeg_folder") return ready;
    throw new Error(`Unexpected command ${command}`);
  });
});
afterEach(cleanup);
describe("録画の準備とエラー表示", () => {
  it("FFmpeg未導入では設定画面に理由を表示し、録画開始を禁止する", async () => {
    render(<App />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "● 録画" }));
    const dialog = screen.getByRole("dialog", { name: "画面を録画する" });
    await within(dialog).findByText(/FFmpegが見つかりません/);
    const start = within(dialog).getByRole("button", { name: "● 録画開始" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    await user.click(start);
    expect(
      commands.mock.calls.some(([command]) => command === "start_recording"),
    ).toBe(false);
  });
  it("有効なFFmpegフォルダー選択後は録画開始できる", async () => {
    commands.mockImplementation(async (command) => {
      if (command === "recover_project") return null;
      if (command === "capture_targets") return [target];
      if (command === "recording_tools") return missing;
      if (command === "choose_ffmpeg_folder") return ready;
      if (command === "start_recording") return true;
      throw new Error(command);
    });
    render(<App />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "● 録画" }));
    const dialog = screen.getByRole("dialog", { name: "画面を録画する" });
    await within(dialog).findByText(/FFmpegが見つかりません/);
    await user.click(
      within(dialog).getByRole("button", { name: "FFmpegのフォルダーを設定" }),
    );
    const start = within(dialog).getByRole("button", { name: "● 録画開始" });
    await waitFor(() =>
      expect((start as HTMLButtonElement).disabled).toBe(false),
    );
    await user.click(start);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(commands).toHaveBeenCalledWith("start_recording", {
      options: { target, cursor: true, quality: "standard" },
    });
  });
  it("録画開始のエラーをモーダル内に表示し、再試行できる", async () => {
    commands.mockImplementation(async (command) => {
      if (command === "recover_project") return null;
      if (command === "capture_targets") return [target];
      if (command === "recording_tools") return ready;
      if (command === "start_recording")
        throw new Error("録画開始に失敗しました: encoder error");
      throw new Error(command);
    });
    render(<App />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "● 録画" }));
    const dialog = screen.getByRole("dialog", { name: "画面を録画する" });
    const start = within(dialog).getByRole("button", { name: "● 録画開始" });
    await waitFor(() =>
      expect((start as HTMLButtonElement).disabled).toBe(false),
    );
    await user.click(start);
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "encoder error",
    );
    expect((start as HTMLButtonElement).disabled).toBe(false);
  });
  it("領域選択の作成中は再クリックを禁止し、失敗後は再試行できる", async () => {
    let rejectSelection: (reason: Error) => void = () => {};
    const pending = new Promise((_, reject) => {
      rejectSelection = reject;
    });
    commands.mockImplementation(async (command) => {
      if (command === "recover_project") return null;
      if (command === "capture_targets") return [target];
      if (command === "recording_tools") return ready;
      if (command === "select_region") return pending;
      throw new Error(command);
    });
    render(<App />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "● 録画" }));
    const dialog = screen.getByRole("dialog", { name: "画面を録画する" });
    const select = within(dialog).getByRole("button", {
      name: "マウスで範囲を選択",
    });
    await waitFor(() =>
      expect((select as HTMLButtonElement).disabled).toBe(false),
    );
    await user.click(select);
    expect((select as HTMLButtonElement).disabled).toBe(true);
    await user.click(select);
    expect(
      commands.mock.calls.filter(([command]) => command === "select_region"),
    ).toHaveLength(1);
    rejectSelection(new Error("領域選択ウィンドウを作成できません"));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "領域選択ウィンドウを作成できません",
    );
    expect((select as HTMLButtonElement).disabled).toBe(false);
  });
});
