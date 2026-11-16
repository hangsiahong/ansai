// Claude's plan limits: Claude Code's own cache is only rewritten when its usage view loads (it sat at 50%
// while the real number was 79%), so ansai polls the same endpoint itself and shows whichever is newer.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const { now } = await import("./db");
const { createAccount, listAccounts, refreshAccountsSoon } = await import("./accounts");
const { fetchClaudeLimits, storedLimits } = await import("./usage");

/** A Claude config folder signed in with this token, and a cache from Claude Code saying `cachedPct`. */
function setup(name: string, opts: { expiresInMs?: number; cachedPct?: number; cachedAgoMs?: number } = {}) {
  const acct = createAccount("claude", name);
  const dir = acct.dir!;
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "tok-secret", refreshToken: "r", expiresAt: now() + (opts.expiresInMs ?? 3600_000) } }),
  );
  if (opts.cachedPct !== undefined)
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: now() - (opts.cachedAgoMs ?? 16 * 3600_000),
          utilization: { seven_day: { utilization: opts.cachedPct, resets_at: new Date(now() + 2 * 86400_000).toISOString() } },
        },
      }),
    );
  return acct;
}

const reply = (pct: number, status = 200) =>
  (async (_url: unknown, init?: RequestInit) => {
    calls.push(init?.headers as Record<string, string>);
    return new Response(JSON.stringify({ five_hour: null, seven_day: { utilization: pct, resets_at: new Date(now() + 86400_000).toISOString() }, noise: { big: 1 } }), { status });
  }) as unknown as typeof fetch;
const calls: Record<string, string>[] = [];

const weekly = (id: string) => {
  refreshAccountsSoon(); // listAccounts() caches for 10s; the usage scan clears it the same way
  return listAccounts().find((a) => a.id === id)!.usage.limits.find((l) => l.id === "seven_day");
};

test("polls the usage endpoint with the account's own token and shows it over a 16-hour-old cache", async () => {
  const a = setup("Stale cache", { cachedPct: 50 });
  expect(weekly(a.id)?.used_percent).toBe(50);

  calls.length = 0;
  expect(await fetchClaudeLimits(a.id, a.dir!, reply(79))).toBe(true);
  expect(calls[0]!.Authorization).toBe("Bearer tok-secret");
  expect(storedLimits(a.id)!.data).not.toHaveProperty("noise"); // only the limits we show are kept
  expect(weekly(a.id)?.used_percent).toBe(79);
});

test("an account with no cache at all (never opened /usage) still gets numbers", async () => {
  const a = setup("No cache");
  expect(weekly(a.id)).toBeUndefined();
  await fetchClaudeLimits(a.id, a.dir!, reply(11));
  expect(weekly(a.id)?.used_percent).toBe(11);
});

test("Claude Code's cache wins when it is the newer one", async () => {
  const a = setup("Fresh cache", { cachedPct: 30, cachedAgoMs: -60_000 }); // fetched a minute from now
  await fetchClaudeLimits(a.id, a.dir!, reply(99));
  expect(weekly(a.id)?.used_percent).toBe(30);
});

test("an expired token is left alone: no request, no refresh", async () => {
  const a = setup("Expired", { expiresInMs: -1000 });
  calls.length = 0;
  expect(await fetchClaudeLimits(a.id, a.dir!, reply(1))).toBe(false);
  expect(calls).toHaveLength(0);
});

test("polls at most every few minutes, and backs off after an error", async () => {
  const a = setup("Throttled");
  calls.length = 0;
  expect(await fetchClaudeLimits(a.id, a.dir!, reply(5))).toBe(true);
  expect(await fetchClaudeLimits(a.id, a.dir!, reply(6))).toBe(false); // too soon
  expect(calls).toHaveLength(1);

  const b = setup("Erroring");
  calls.length = 0;
  expect(await fetchClaudeLimits(b.id, b.dir!, reply(5, 429))).toBe(false);
  expect(await fetchClaudeLimits(b.id, b.dir!, reply(5))).toBe(false); // backing off
  expect(calls).toHaveLength(1);
  expect(storedLimits(b.id)).toBeNull();
});
