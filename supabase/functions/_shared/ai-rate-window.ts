// Shared output-tokens-per-minute (OTPM) governor across edge functions.
// Uses a tiny `ai_rate_window` table as a 60s sliding window.
// All callers reserve before issuing the AI request and the window is
// self-cleaning (rows older than 5min are deleted opportunistically).

type SupabaseLike = {
  from: (t: string) => any;
};

export interface ReserveResult {
  reserved: boolean;
  waitMs: number;
  used: number;
  cap: number;
}

const DEFAULT_CAPS: Record<string, number> = {
  "claude-haiku-4-5": 3500,    // Tier-1 OTPM is 4000; keep 10% safety margin.
  "claude-sonnet-4-6": 7200,   // Tier-1 OTPM is 8000.
};

export async function reserveOTPM(
  supabase: SupabaseLike,
  model: string,
  tokens: number,
): Promise<ReserveResult> {
  const cap = DEFAULT_CAPS[model] ?? 3500;
  const now = Date.now();
  const sinceIso = new Date(now - 60_000).toISOString();

  // Sum currently-reserved tokens for this model in the last 60s.
  const { data: rows } = await supabase
    .from("ai_rate_window")
    .select("reserved_tokens, reserved_at")
    .eq("model", model)
    .gte("reserved_at", sinceIso);

  let used = 0;
  let oldestAgeMs = 0;
  for (const r of rows ?? []) {
    used += (r as any).reserved_tokens ?? 0;
    const age = now - new Date((r as any).reserved_at).getTime();
    if (age > oldestAgeMs) oldestAgeMs = age;
  }

  if (used + tokens > cap) {
    // Wait until the oldest reservation ages out of the 60s window.
    const waitMs = Math.max(2_000, 60_000 - oldestAgeMs + 500);
    return { reserved: false, waitMs, used, cap };
  }

  await supabase.from("ai_rate_window").insert({
    model,
    reserved_tokens: tokens,
  });

  // Opportunistic cleanup of rows older than 5min (cheap, no cron needed).
  const cleanupBefore = new Date(now - 5 * 60_000).toISOString();
  await supabase
    .from("ai_rate_window")
    .delete()
    .lt("reserved_at", cleanupBefore);

  return { reserved: true, waitMs: 0, used: used + tokens, cap };
}
