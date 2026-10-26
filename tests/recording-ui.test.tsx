// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as platform from "../src/platform";
import * as recorder from "../src/recorder";
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
vi.mock("../src/recorder", () => ({
  prepareRecording: vi.fn(),
  recordingSupported: vi.fn(),
}));
const result = {
  blob: new Blob(["x"]),
  extension: "webm" as const,
  seconds: 5,
  hasAudio: false,
};
function fakeSession() {
  let finish: (r: typeof result) => void = () => {};
  const session = {
    paused: false,
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(() => finish(result)),
    seconds: () => 1,
    finished: new Promise<typeof result>((resolve) => {
      finish = resolve;
    }),
  };
  return session;
}
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(platform.recoverProject).mockReset().mockResolvedValue(null);
  vi.mocked(platform.autosave).mockReset().mockResolvedValue();
  vi.mocked(platform.addRecording)
    .mockReset()
    .mockResolvedValue({
      id: "rec",
      path: "Rec_01.webm",
      name: "Rec_01.webm",
      duration: 5,
      width: 1920,
      height: 1080,
      hasAudio: false,
    });
  vi.mocked(recorder.recordingSupported).mockReset().mockReturnValue(true);
  vi.mocked(recorder.prepareRecording).mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("ブラウザ録画", () => {
  it("設定を渡して共有を選ばせ、3秒後に録画し、停止で取り込む", async () => {
    const session = fakeSession();
    const cancel = vi.fn();
    vi.mocked(recorder.prepareRecording).mockResolvedValue({
      hasAudio: true,
      cancel,
      start: () => session as never,
    });
    render(<App />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "● 録画" }));
    const dialog = screen.getByRole("dialog", { name: "画面を録画する" });
    await user.click(within(dialog).getByLabelText("マイク音声を録音"));
    await user.click(within(dialog).getByRole("button", { name: "● 録画開始" }));
    expect(recorder.prepareRecording).toHaveBeenCalledWith({
      cursor: true,
      quality: "standard",
      microphone: true,
      systemAudio: false,
    });
    expect(await within(dialog).findByText("3")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const bar = screen.getByRole("toolbar", { name: "録画中" });
    await user.click(within(bar).getByRole("button", { name: "一時停止" }));
    expect(session.pause).toHaveBeenCalled();
    await user.click(within(bar).getByRole("button", { name: "停止・編集" }));
    expect(
      await screen.findByRole("button", { name: "クリップ 1: Rec_01.webm" }),
    ).toBeTruthy();
    expect(platform.addRecording).toHaveBeenCalledWith(
      expect.objectContaining({ media: [] }),
      result,
    );
    expect(screen.queryByRole("toolbar", { name: "録画中" })).toBeNull();
  });
  it("共有を拒否した場合は理由をモーダル内に表示し、再試行できる", async () => {
    vi.mocked(recorder.prepareRecording).mockRejectedValueOnce(
      new DOMException("denied", "NotAllowedError"),
    );
    render(<App />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "● 録画" }));
    const dialog = screen.getByRole("dialog", { name: "画面を録画する" });
    const start = within(dialog).getByRole("button", { name: "● 録画開始" });
    await user.click(start);
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "画面の共有が許可されませんでした",
    );
    expect((start as HTMLButtonElement).disabled).toBe(false);
  });
  it("録画に対応しないブラウザでは録画ボタンを無効にし、理由を表示する", () => {
    vi.mocked(recorder.recordingSupported).mockReturnValue(false);
    render(<App />);
    expect(
      (screen.getByRole("button", { name: "● 録画" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/このブラウザでは画面録画を利用できません/)).toBeTruthy();
  });
});
