import React, { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Media, AudioClip } from "./editor";
export function AudioPlayback({
  items,
  media,
  time,
  playing,
  rate,
}: {
  items: AudioClip[];
  media: Media[];
  time: number;
  playing: boolean;
  rate: number;
}) {
  return (
    <>
      {items.map((a) => (
        <AudioSource
          key={a.id}
          item={a}
          media={media.find((m) => m.id === a.mediaId)}
          time={time}
          playing={playing}
          rate={rate}
        />
      ))}
    </>
  );
}
function AudioSource({
  item,
  media,
  time,
  playing,
  rate,
}: {
  item: AudioClip;
  media: Media | undefined;
  time: number;
  playing: boolean;
  rate: number;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    const active = time >= item.at && time < item.at + item.end - item.start;
    audio.volume = item.muted ? 0 : item.gain;
    audio.playbackRate = rate;
    if (active) {
      const source = item.start + time - item.at;
      if (Math.abs(audio.currentTime - source) > 0.15)
        audio.currentTime = source;
    }
    if (playing && active) void audio.play().catch(() => {});
    else audio.pause();
  }, [item, time, playing, rate]);
  return media ? (
    <audio
      ref={ref}
      src={convertFileSrc(media.previewPath ?? media.path)}
      preload="metadata"
    />
  ) : null;
}
export function AudioProperties({
  item,
  total,
  sourceDuration,
  change,
  remove,
}: {
  item: AudioClip;
  total: number;
  sourceDuration: number;
  change: (a: AudioClip) => void;
  remove: () => void;
}) {
  return (
    <section className="annotation-properties">
      <h3>追加音声の設定</h3>
      <label>
        配置時刻（秒）
        <input
          type="number"
          min="0"
          max={total - (item.end - item.start)}
          step=".1"
          value={item.at}
          onChange={(e) => {
            const at = Number(e.target.value);
            if (at >= 0 && at + item.end - item.start <= total)
              change({ ...item, at });
          }}
        />
      </label>
      <label>
        素材の開始（秒）
        <input
          type="number"
          min="0"
          max={item.end - 0.1}
          step=".1"
          value={item.start}
          onChange={(e) => {
            const start = Number(e.target.value);
            if (
              start >= 0 &&
              start < item.end &&
              item.at + item.end - start <= total
            )
              change({ ...item, start });
          }}
        />
      </label>
      <label>
        素材の終了（秒）
        <input
          type="number"
          min={item.start + 0.1}
          max={Math.min(sourceDuration, item.start + total - item.at)}
          step=".1"
          value={item.end}
          onChange={(e) => {
            const end = Number(e.target.value);
            if (
              end > item.start &&
              end <= sourceDuration &&
              item.at + end - item.start <= total
            )
              change({ ...item, end });
          }}
        />
      </label>
      <label>
        音量
        <input
          type="range"
          min="0"
          max="1"
          step=".05"
          value={item.gain}
          onChange={(e) => change({ ...item, gain: Number(e.target.value) })}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={item.muted}
          onChange={(e) => change({ ...item, muted: e.target.checked })}
        />
        消音
      </label>
      <button className="danger" onClick={remove}>
        追加音声を削除
      </button>
    </section>
  );
}
