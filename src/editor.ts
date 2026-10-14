import {
  validateAnnotation,
  type Annotation,
  type ClickInfo,
} from "./annotations";
export interface Media {
  previewPath?: string;
  codec?: string;
  kind?: "gap";
  id: string;
  path: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}
export interface Clip {
  muted?: boolean;
  gain?: number;
  name?: string;
  id: string;
  mediaId: string;
  start: number;
  end: number;
}
export interface AudioClip {
  id: string;
  mediaId: string;
  start: number;
  end: number;
  at: number;
  gain: number;
  muted: boolean;
}
export interface Project {
  version: 1 | 2;
  annotations?: Annotation[];
  clicks?: ClickInfo[];
  audio?: AudioClip[];
  media: Media[];
  clips: Clip[];
}
export const emptyProject = (): Project => ({
  version: 1,
  media: [],
  clips: [],
});
export const duration = (clips: Clip[]) =>
  clips.reduce((sum, c) => sum + c.end - c.start, 0);
export function locate(clips: Clip[], time: number) {
  let offset = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i],
      length = c.end - c.start;
    if (time < offset + length || i === clips.length - 1)
      return {
        clip: c,
        index: i,
        sourceTime: c.start + Math.min(length, Math.max(0, time - offset)),
        offset,
      };
    offset += length;
  }
  return null;
}
export function split(clips: Clip[], time: number): Clip[] {
  const hit = locate(clips, time);
  if (
    !hit ||
    hit.sourceTime <= hit.clip.start + 0.001 ||
    hit.sourceTime >= hit.clip.end - 0.001
  )
    return clips;
  return clips.flatMap((c, i) =>
    i === hit.index
      ? [
          { ...c, end: hit.sourceTime },
          { ...c, id: crypto.randomUUID(), start: hit.sourceTime },
        ]
      : [c],
  );
}
export function cutRange(clips: Clip[], start: number, end: number): Clip[] {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start
  )
    return clips;
  let offset = 0;
  return clips.flatMap((c) => {
    const begin = offset,
      finish = offset + c.end - c.start;
    offset = finish;
    if (finish <= start || begin >= end) return [c];
    const kept: Clip[] = [];
    if (start > begin) kept.push({ ...c, end: c.start + start - begin });
    if (end < finish)
      kept.push({
        ...c,
        id: crypto.randomUUID(),
        start: c.start + end - begin,
      });
    return kept;
  });
}
export function moveClip(clips: Clip[], from: number, to: number): Clip[] {
  if (from < 0 || to < 0 || from >= clips.length || to >= clips.length)
    return clips;
  const result = [...clips];
  const [clip] = result.splice(from, 1);
  result.splice(to, 0, clip);
  return result;
}
export function validateProject(value: unknown): Project {
  const p = value as Project;
  if (
    !p ||
    (p.version !== 1 && p.version !== 2) ||
    !Array.isArray(p.media) ||
    !Array.isArray(p.clips)
  )
    throw new Error("対応していないプロジェクト形式です。");
  const ids = new Set<string>();
  for (const m of p.media) {
    if (
      !m ||
      typeof m.id !== "string" ||
      ids.has(m.id) ||
      typeof m.path !== "string" ||
      typeof m.name !== "string" ||
      !Number.isFinite(m.duration) ||
      m.duration <= 0 ||
      !Number.isFinite(m.width) ||
      m.width <= 0 ||
      !Number.isFinite(m.height) ||
      m.height <= 0 ||
      typeof m.hasAudio !== "boolean"
    )
      throw new Error("動画情報が不正です。");
    ids.add(m.id);
  }
  const clips = new Set<string>();
  for (const c of p.clips) {
    const m = p.media.find((m) => m.id === c.mediaId);
    if (
      !c ||
      typeof c.id !== "string" ||
      clips.has(c.id) ||
      (c.muted !== undefined && typeof c.muted !== "boolean") ||
      (c.gain !== undefined &&
        (!Number.isFinite(c.gain) || c.gain < 0 || c.gain > 1)) ||
      (c.name !== undefined &&
        (typeof c.name !== "string" ||
          !c.name.trim() ||
          c.name.length > 100)) ||
      !m ||
      !Number.isFinite(c.start) ||
      !Number.isFinite(c.end) ||
      c.start < 0 ||
      c.end <= c.start ||
      c.end > m.duration + 0.05
    )
      throw new Error("クリップの範囲が不正です。");
    clips.add(c.id);
  }
  const annotationIds = new Set<string>();
  for (const a of p.annotations ?? []) {
    if (!validateAnnotation(a, duration(p.clips)) || annotationIds.has(a.id))
      throw new Error("注釈情報が不正です");
    annotationIds.add(a.id);
  }
  for (const c of p.clicks ?? []) {
    if (
      ![c.time, c.x, c.y].every(Number.isFinite) ||
      c.time < 0 ||
      c.time > duration(p.clips) + 0.05 ||
      c.x < 0 ||
      c.x > 1 ||
      c.y < 0 ||
      c.y > 1 ||
      !p.media.some((m) => m.id === c.mediaId)
    )
      throw new Error("クリック記録が不正です");
  }
  const audioIds = new Set<string>();
  for (const a of p.audio ?? []) {
    const source = p.media.find((m) => m.id === a.mediaId);
    if (
      audioIds.has(a.id) ||
      !source?.hasAudio ||
      ![a.start, a.end, a.at, a.gain].every(Number.isFinite) ||
      a.start < 0 ||
      a.end <= a.start ||
      a.end > source.duration + 0.05 ||
      a.at < 0 ||
      a.at + a.end - a.start > duration(p.clips) + 0.05 ||
      a.gain < 0 ||
      a.gain > 1 ||
      typeof a.muted !== "boolean"
    )
      throw new Error("音声トラックが不正です");
    audioIds.add(a.id);
  }
  return p;
}
export const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;

export function cutProject(p: Project, start: number, end: number): Project {
  const clips = cutRange(p.clips, start, end);
  if (clips === p.clips) return p;
  const shift = (t: number) =>
    t <= start ? t : t >= end ? t - (end - start) : start;
  const annotations = (p.annotations ?? [])
    .map((a) => ({ ...a, start: shift(a.start), end: shift(a.end) }))
    .filter((a) => a.end > a.start);
  return {
    ...p,
    clips,
    annotations,
    audio: (p.audio ?? []).flatMap((a) => {
      const finish = a.at + a.end - a.start;
      if (finish <= start) return [a];
      if (a.at >= end) return [{ ...a, at: a.at - (end - start) }];
      const result: AudioClip[] = [];
      if (a.at < start) result.push({ ...a, end: a.start + start - a.at });
      if (finish > end)
        result.push({
          ...a,
          id: crypto.randomUUID(),
          at: shift(Math.max(a.at, end)),
          start: a.start + Math.max(0, end - a.at),
        });
      return result;
    }),
    clicks: (p.clicks ?? [])
      .filter((c) => c.time < start || c.time >= end)
      .map((c) => ({ ...c, time: shift(c.time) })),
  };
}
