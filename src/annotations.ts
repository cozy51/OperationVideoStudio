export const annotationKinds = [
  "text",
  "arrow",
  "rectangle",
  "ellipse",
  "marker",
  "highlight",
  "blur",
  "mosaic",
] as const;
export type AnnotationKind = (typeof annotationKinds)[number];
export const kindNames: Record<AnnotationKind, string> = {
  text: "テキスト",
  arrow: "矢印",
  rectangle: "四角形",
  ellipse: "円形",
  marker: "番号",
  highlight: "ハイライト",
  blur: "ぼかし",
  mosaic: "モザイク",
};
export interface Annotation {
  id: string;
  kind: AnnotationKind;
  start: number;
  end: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  background: string;
  backgroundOpacity?: number;
  opacity: number;
  lineWidth: number;
  fontSize: number;
  fontFamily: string;
}
export function newAnnotation(
  kind: AnnotationKind,
  time: number,
  total: number,
): Annotation {
  const start = Math.min(Math.max(0, time), Math.max(0, total - 1 / 30));
  return {
    id: crypto.randomUUID(),
    kind,
    start,
    end: Math.min(total, start + 3),
    x: 0.15,
    y: 0.2,
    width: kind === "marker" ? 0.08 : 0.35,
    height: kind === "marker" ? 0.14 : 0.15,
    text: kind === "marker" ? "1" : "ここをクリック",
    color: "#e6263c",
    background: "#ffffff",
    backgroundOpacity: 0.8,
    opacity: kind === "highlight" ? 0.35 : 1,
    lineWidth: 4,
    fontSize: 36,
    fontFamily: "Yu Gothic UI",
  };
}
export function validateAnnotation(a: Annotation, total: number) {
  return (
    !!a &&
    typeof a.id === "string" &&
    annotationKinds.includes(a.kind) &&
    [
      a.start,
      a.end,
      a.x,
      a.y,
      a.width,
      a.height,
      a.opacity,
      a.lineWidth,
      a.fontSize,
    ].every(Number.isFinite) &&
    a.start >= 0 &&
    a.end > a.start &&
    a.end <= total + 0.05 &&
    a.x >= 0 &&
    a.y >= 0 &&
    a.width > 0 &&
    a.height > 0 &&
    a.x + a.width <= 1.001 &&
    a.y + a.height <= 1.001 &&
    Number.isFinite(a.backgroundOpacity ?? 1) &&
    (a.backgroundOpacity ?? 1) >= 0 &&
    (a.backgroundOpacity ?? 1) <= 1 &&
    a.opacity >= 0 &&
    a.opacity <= 1 &&
    a.lineWidth >= 0 &&
    a.lineWidth <= 20 &&
    a.fontSize >= 8 &&
    a.fontSize <= 160 &&
    /^#[\da-f]{6}$/i.test(a.color) &&
    /^#[\da-f]{6}$/i.test(a.background) &&
    typeof a.text === "string" &&
    a.text.length <= 1000 &&
    typeof a.fontFamily === "string" &&
    a.fontFamily.length <= 100
  );
}
export function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  w: number,
  h: number,
) {
  const x = a.x * w,
    y = a.y * h,
    aw = a.width * w,
    ah = a.height * h,
    scale = h / 1080;
  ctx.save();
  ctx.globalAlpha = a.opacity;
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = a.lineWidth * scale;
  if (a.kind === "rectangle") ctx.strokeRect(x, y, aw, ah);
  if (a.kind === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(x + aw / 2, y + ah / 2, aw / 2, ah / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (a.kind === "highlight") {
    ctx.fillRect(x, y, aw, ah);
  }
  if (a.kind === "arrow") {
    const ex = x + aw,
      ey = y + ah,
      angle = Math.atan2(ah, aw),
      size = 24 * scale;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(
      ex - size * Math.cos(angle - 0.45),
      ey - size * Math.sin(angle - 0.45),
    );
    ctx.lineTo(
      ex - size * Math.cos(angle + 0.45),
      ey - size * Math.sin(angle + 0.45),
    );
    ctx.closePath();
    ctx.fill();
  }
  if (a.kind === "marker") {
    ctx.globalAlpha = a.opacity * (a.backgroundOpacity ?? 1);
    ctx.fillStyle = a.background;
    ctx.beginPath();
    ctx.arc(x + aw / 2, y + ah / 2, Math.min(aw, ah) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = a.opacity;
    ctx.stroke();
    ctx.fillStyle = a.color;
    ctx.font = `${a.fontSize * scale}px "${a.fontFamily.replace(/["\\]/g, "")}"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(a.text, x + aw / 2, y + ah / 2);
    ctx.restore();
    return;
  }
  if (a.kind === "text") {
    ctx.fillStyle = a.background;
    ctx.globalAlpha = a.opacity * (a.backgroundOpacity ?? 1);
    ctx.fillRect(x, y, aw, ah);
    ctx.globalAlpha = a.opacity;
    if (a.lineWidth > 0) ctx.strokeRect(x, y, aw, ah);
    ctx.fillStyle = a.color;
    ctx.font = `${a.fontSize * scale}px "${a.fontFamily.replace(/["\\]/g, "")}"`;
    ctx.textBaseline = "top";
    ctx.beginPath();
    ctx.rect(x, y, aw, ah);
    ctx.clip();
    const words = a.text.split("\n");
    let yy = y + 8 * scale;
    for (const word of words) {
      let line = "";
      for (const char of word) {
        if (ctx.measureText(line + char).width > aw - 16 * scale && line) {
          ctx.fillText(line, x + 8 * scale, yy);
          yy += a.fontSize * scale * 1.25;
          line = "";
        }
        line += char;
      }
      ctx.fillText(line, x + 8 * scale, yy);
      yy += a.fontSize * scale * 1.25;
    }
  }
  ctx.restore();
}
export function outputSize(
  media: { width: number; height: number } | undefined,
  resolution: string,
): [number, number] {
  return resolution === "720p"
    ? [1280, 720]
    : resolution === "source" && media
      ? [Math.floor(media.width / 2) * 2, Math.floor(media.height / 2) * 2]
      : [1920, 1080];
}
export function renderAssets(
  items: Annotation[],
  w: number,
  h: number,
  clicks = false,
) {
  const assets = items
    .filter((a) => a.kind !== "blur" && a.kind !== "mosaic")
    .map((a) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("注釈画像を作成できません");
      drawAnnotation(ctx, a, w, h);
      return { id: a.id, png: canvas.toDataURL("image/png").split(",")[1] };
    });
  if (clicks) {
    const side = Math.max(8, Math.round((64 * h) / 1080));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = side;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("クリック画像を作成できません");
    drawClick(ctx, side / 2, side / 2, side);
    assets.push({
      id: "__click_marker",
      png: canvas.toDataURL("image/png").split(",")[1],
    });
  }
  return assets;
}

export interface ClickInfo {
  time: number;
  x: number;
  y: number;
  mediaId: string;
}
export function drawClick(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  side: number,
) {
  ctx.save();
  ctx.fillStyle = "rgba(255,176,40,.28)";
  ctx.strokeStyle = "#ff7a00";
  ctx.lineWidth = side * 0.07;
  ctx.beginPath();
  ctx.arc(x, y, side * 0.36, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
export function clickPoint(
  c: ClickInfo,
  media: { id: string; width: number; height: number }[],
  w: number,
  h: number,
): [number, number] {
  const m = media.find((m) => m.id === c.mediaId);
  if (!m) return [c.x * w, c.y * h];
  const scale = Math.min(w / m.width, h / m.height);
  return [
    (w - m.width * scale) / 2 + c.x * m.width * scale,
    (h - m.height * scale) / 2 + c.y * m.height * scale,
  ];
}
