export interface Media {
  id: string;
  path: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}
export interface Clip {
  id: string;
  mediaId: string;
  start: number;
  end: number;
}
export interface Project {
  version: 1;
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
    p.version !== 1 ||
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
  return p;
}
export const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
