import React, { useEffect, useRef, useState } from "react";
import {
  annotationKinds,
  kindNames,
  newAnnotation,
  drawAnnotation,
  drawClick,
  clickPoint,
  type ClickInfo,
  type Annotation,
} from "./annotations";
// Moves keyboard focus to the text field of the selected annotation's settings.
export function focusAnnotationText() {
  requestAnimationFrame(() => {
    const field = document.getElementById("annotation-text") as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    if (!field) return;
    field.scrollIntoView({ block: "nearest" });
    field.focus();
    field.select();
  });
}
export function AnnotationTools({
  time,
  total,
  add,
  disabled,
}: {
  time: number;
  total: number;
  add: (a: Annotation) => void;
  disabled: boolean;
}) {
  return (
    <div className="annotation-tools">
      <h3>注釈を追加</h3>
      {annotationKinds.map((kind) => (
        <button
          key={kind}
          disabled={disabled || !total}
          onClick={() => add(newAnnotation(kind, time, total))}
        >
          {kindNames[kind]}
        </button>
      ))}
      <p className="hint">
        現在の時刻に追加し、プレビュー上でドラッグして配置できます。文字はダブルクリックで編集できます。
      </p>
    </div>
  );
}
export function AnnotationProperties({
  item,
  total,
  change,
  remove,
  duplicate,
}: {
  item: Annotation;
  total: number;
  change: (a: Annotation) => void;
  remove: () => void;
  duplicate: () => void;
}) {
  const number = (
    key: keyof Annotation,
    min: number,
    max: number,
    step: number,
  ) => (
    <label key={key}>
      {
        (
          {
            start: "表示開始（秒）",
            end: "表示終了（秒）",
            width: "幅（比率）",
            height: "高さ（比率）",
            fontSize: "文字サイズ",
            lineWidth: "枠線の太さ",
            opacity: "不透明度",
            backgroundOpacity: "背景の不透明度",
          } as Record<string, string>
        )[key]
      }
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={(item[key] as number) ?? 1}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (n < min || n > max) return;
          const next = { ...item, [key]: n };
          if (
            next.end > next.start &&
            next.x + next.width <= 1.001 &&
            next.y + next.height <= 1.001
          )
            change(next);
        }}
      />
    </label>
  );
  return (
    <section className="annotation-properties">
      <h3>{kindNames[item.kind]}の設定</h3>
      {(item.kind === "text" || item.kind === "marker") && (
        <>
          <label>
            文字
            {item.kind === "text" ? (
              <textarea
                id="annotation-text"
                rows={3}
                maxLength={1000}
                value={item.text}
                onChange={(e) => change({ ...item, text: e.target.value })}
              />
            ) : (
              <input
                id="annotation-text"
                type="text"
                maxLength={1000}
                value={item.text}
                onChange={(e) => change({ ...item, text: e.target.value })}
              />
            )}
          </label>
          {number("fontSize", 8, 160, 1)}
          <label>
            フォント
            <select
              value={item.fontFamily}
              onChange={(e) => change({ ...item, fontFamily: e.target.value })}
            >
              {["Yu Gothic UI", "Meiryo", "MS Gothic", "Arial"].map((font) => (
                <option key={font}>{font}</option>
              ))}
            </select>
          </label>
        </>
      )}
      {number("start", 0, Math.max(0, item.end - 1 / 30), 1 / 30)}
      {number("end", item.start + 1 / 30, total, 1 / 30)}
      {number("width", 0.01, 1 - item.x, 0.01)}
      {number("height", 0.01, 1 - item.y, 0.01)}
      {number("opacity", 0, 1, 0.05)}
      {(item.kind === "text" || item.kind === "marker") &&
        number("backgroundOpacity", 0, 1, 0.05)}
      {number("lineWidth", 0, 20, 1)}
      <label>
        色
        <input
          type="color"
          value={item.color}
          onChange={(e) => change({ ...item, color: e.target.value })}
        />
      </label>
      <label>
        背景色
        <input
          type="color"
          value={item.background}
          onChange={(e) => change({ ...item, background: e.target.value })}
        />
      </label>
      <button onClick={duplicate}>複製</button>
      <button className="danger" onClick={remove}>
        注釈を削除
      </button>
    </section>
  );
}
export function OverlayPreview({
  items,
  time,
  w,
  h,
  selected,
  select,
  change,
  video,
  clicks,
  media,
}: {
  items: Annotation[];
  time: number;
  w: number;
  h: number;
  selected: string | null;
  select: (id: string) => void;
  change: (a: Annotation) => void;
  video: React.RefObject<HTMLVideoElement | null>;
  clicks: ClickInfo[];
  media: { id: string; width: number; height: number }[];
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const visibleItems = items.map((a) => (draft?.id === a.id ? draft : a));
  const drag = useRef<{
    a: Annotation;
    x: number;
    y: number;
    handle: string;
  } | null>(null);
  const dragged = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current!;
    const bounds = e.currentTarget.parentElement!.getBoundingClientRect();
    return resizeAnnotation(
      d.a,
      d.handle,
      (e.clientX - d.x) / bounds.width,
      (e.clientY - d.y) / bounds.height,
    );
  };
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    for (const a of visibleItems) {
      if (a.start <= time && time < a.end) drawAnnotation(ctx, a, w, h);
    }
    const click = clicks
      .filter((c) => c.time <= time && time < c.time + 0.4)
      .at(-1);
    if (click) {
      const [x, y] = clickPoint(click, media, w, h);
      drawClick(ctx, x, y, Math.max(8, Math.round((64 * h) / 1080)));
    }
  }, [items, draft, time, w, h, clicks, media]);
  const active = visibleItems.filter((a) => a.start <= time && time < a.end);
  return (
    <div className="annotation-layer">
      {active
        .filter((a) => a.kind === "blur" || a.kind === "mosaic")
        .map((a) => (
          <div
            className="mask-region"
            key={a.id}
            style={{
              left: `${a.x * 100}%`,
              top: `${a.y * 100}%`,
              width: `${a.width * 100}%`,
              height: `${a.height * 100}%`,
            }}
          >
            {a.kind === "blur" ? (
              <div className="blur-mask" />
            ) : (
              <Mosaic video={video} a={a} time={time} w={w} h={h} />
            )}
          </div>
        ))}
      <canvas ref={canvas} width={w} height={h} />
      {active.map((a) => (
        <div
          key={a.id}
          className={`annotation-hit ${selected === a.id ? "selected" : ""}`}
          style={{
            left: `${a.x * 100}%`,
            top: `${a.y * 100}%`,
            width: `${a.width * 100}%`,
            height: `${a.height * 100}%`,
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            // Keep the browser from starting a text-selection drag, which
            // cancels the pointer and drops the move/resize.
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            select(a.id);
            drag.current = {
              a,
              x: e.clientX,
              y: e.clientY,
              handle: (e.target as HTMLElement).dataset.handle ?? "",
            };
          }}
          onDoubleClick={() => {
            select(a.id);
            if (a.kind === "text" || a.kind === "marker") focusAnnotationText();
          }}
          onPointerMove={(e) => {
            if (drag.current) setDraft(dragged(e));
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            if (!d) return;
            const moved = e.clientX !== d.x || e.clientY !== d.y;
            const next = dragged(e);
            drag.current = null;
            setDraft(null);
            if (moved) change(next);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDraft(null);
          }}
        >
          <span className="annotation-drag-label" />
          {selected === a.id &&
            resizeHandles.map((handle) => (
              <span
                key={handle}
                data-handle={handle}
                className={`resize-handle ${handle}`}
                aria-label="サイズ変更"
              />
            ))}
        </div>
      ))}
    </div>
  );
}
const resizeHandles = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
// Moves (handle "") or resizes an annotation by the given drag delta,
// expressed as a fraction of the preview, keeping it inside the frame.
export function resizeAnnotation(
  a: Annotation,
  handle: string,
  dx: number,
  dy: number,
): Annotation {
  const min = 0.01;
  let { x, y, width, height } = a;
  if (!handle) {
    x = Math.min(1 - width, Math.max(0, x + dx));
    y = Math.min(1 - height, Math.max(0, y + dy));
  }
  if (handle.includes("w")) {
    const left = Math.min(x + width - min, Math.max(0, x + dx));
    width += x - left;
    x = left;
  }
  if (handle.includes("e")) width = Math.min(1 - x, Math.max(min, width + dx));
  if (handle.includes("n")) {
    const top = Math.min(y + height - min, Math.max(0, y + dy));
    height += y - top;
    y = top;
  }
  if (handle.includes("s"))
    height = Math.min(1 - y, Math.max(min, height + dy));
  return { ...a, x, y, width, height };
}
function Mosaic({
  video,
  a,
  time,
  w,
  h,
}: {
  video: React.RefObject<HTMLVideoElement | null>;
  a: Annotation;
  time: number;
  w: number;
  h: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let request = 0;
    const draw = () => {
      const v = video.current,
        ctx = canvas.current?.getContext("2d");
      if (v && ctx && v.readyState >= 2) {
        try {
          const scale = Math.min(w / v.videoWidth, h / v.videoHeight),
            pw = v.videoWidth * scale,
            ph = v.videoHeight * scale,
            ox = (w - pw) / 2,
            oy = (h - ph) / 2;
          ctx.fillStyle = "black";
          ctx.fillRect(0, 0, canvas.current!.width, canvas.current!.height);
          ctx.drawImage(
            v,
            (a.x * w - ox) / scale,
            (a.y * h - oy) / scale,
            (a.width * w) / scale,
            (a.height * h) / scale,
            0,
            0,
            canvas.current!.width,
            canvas.current!.height,
          );
        } catch {
          ctx.fillStyle = "black";
          ctx.fillRect(0, 0, canvas.current!.width, canvas.current!.height);
        }
      }
      request = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(request);
  }, [video, a, time, w, h]);
  return (
    <canvas
      className="mosaic-mask"
      ref={canvas}
      width={Math.max(1, Math.floor((a.width * w) / 16))}
      height={Math.max(1, Math.floor((a.height * h) / 16))}
    />
  );
}
export function AnnotationTrack({
  items,
  total,
  select,
  change,
}: {
  items: Annotation[];
  total: number;
  select: (id: string) => void;
  change: (a: Annotation) => void;
}) {
  const drag = useRef<{
    a: Annotation;
    x: number;
    width: number;
    mode: "start" | "end" | "move";
  } | null>(null);
  return (
    <div className="annotation-track">
      <span className="track-label">注釈</span>
      <div
        className="annotation-bars"
        style={{ minHeight: Math.max(44, items.length * 38 + 10) }}
      >
        {items.map((a, index) => (
          <div
            key={a.id}
            className="annotation-bar"
            title={
              a.kind === "text" || a.kind === "marker"
                ? "ダブルクリックで文字を編集"
                : undefined
            }
            onDoubleClick={() => {
              select(a.id);
              if (a.kind === "text" || a.kind === "marker")
                focusAnnotationText();
            }}
            style={{
              top: 5 + index * 38,
              left: `${(a.start / total) * 100}%`,
              width: `${((a.end - a.start) / total) * 100}%`,
            }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              select(a.id);
              drag.current = {
                a,
                x: e.clientX,
                width:
                  e.currentTarget.parentElement!.getBoundingClientRect().width,
                mode:
                  ((e.target as HTMLElement).dataset.edge as "start" | "end") ??
                  "move",
              };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const delta = ((e.clientX - d.x) / d.width) * total;
              let start = d.a.start,
                end = d.a.end;
              if (d.mode === "start")
                start = Math.min(end - 1 / 30, Math.max(0, start + delta));
              else if (d.mode === "end")
                end = Math.max(start + 1 / 30, Math.min(total, end + delta));
              else {
                start = Math.min(
                  total - (end - start),
                  Math.max(0, start + delta),
                );
                end = start + d.a.end - d.a.start;
              }
              e.currentTarget.style.left = `${(start / total) * 100}%`;
              e.currentTarget.style.width = `${((end - start) / total) * 100}%`;
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              drag.current = null;
              // A plain click (or double-click) must not add an undo step.
              if (!d || e.clientX === d.x) return;
              const delta = ((e.clientX - d.x) / d.width) * total;
              let start = d.a.start,
                end = d.a.end;
              if (d.mode === "start")
                start = Math.min(end - 1 / 30, Math.max(0, start + delta));
              else if (d.mode === "end")
                end = Math.max(start + 1 / 30, Math.min(total, end + delta));
              else {
                start = Math.min(
                  total - (end - start),
                  Math.max(0, start + delta),
                );
                end = start + d.a.end - d.a.start;
              }
              change({ ...d.a, start, end });
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <span data-edge="start" className="bar-edge">
              │
            </span>
            {kindNames[a.kind]} {a.text.slice(0, 8)}
            <span data-edge="end" className="bar-edge right">
              │
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
