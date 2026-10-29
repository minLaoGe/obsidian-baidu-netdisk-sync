export const MIN_APP_VERSION = "1.14.4";
export function supportsAppVersion(version: string): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version || "");
  if (!parts) return false;
  const actual = parts.slice(1,4).map(Number), minimum = MIN_APP_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (actual[i] !== minimum[i]) return actual[i] > minimum[i]; }
  return true;
}
