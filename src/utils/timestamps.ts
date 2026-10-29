/** Millisecond timestamps inside the plugin; Baidu uses whole Unix seconds. */
export interface FileTimes { mtime?: number; ctime?: number; }
export function validTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? value : undefined;
}
export function remoteTime(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const seconds = Number(value);
  return Number.isInteger(seconds) ? validTime(seconds * 1000) : undefined;
}
export function writeTimes(times?: FileTimes): FileTimes {
  const result: FileTimes = {};
  const mtime = validTime(times?.mtime), ctime = validTime(times?.ctime);
  if (mtime !== undefined) result.mtime = mtime;
  if (ctime !== undefined) result.ctime = ctime;
  return result;
}
