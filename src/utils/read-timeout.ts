/** Bound read-only requests; timeout never implies a remote write was cancelled. */
export async function boundedInventoryRead<T>(operation: Promise<T>, timeoutMs = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("SYNC_REMOTE_TIMEOUT")), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
