const windows = new Map<string, { count: number; resetAt: number }>();
export async function allowRequest(key: string, limit = 10, windowMs = 60_000): Promise<boolean> {
  const { isMockMode } = await import("@/lib/environment");
  if (!isMockMode()) {
    const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
    const client = createSupabaseAdminClient();
    if (!client) return false;
    const { data, error } = await client.rpc("consume_api_rate_limit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: Math.max(1, Math.ceil(windowMs / 1000)),
    });
    return !error && data === true;
  }
  const now = Date.now();
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return Promise.resolve(true);
  }
  if (current.count >= limit) return Promise.resolve(false);
  current.count += 1;
  return Promise.resolve(true);
}
