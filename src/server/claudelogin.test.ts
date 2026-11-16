// A Claude login that dies mid-task is a bad moment to find out. ansai reads when the login stops renewing
// (the refresh token's expiry) and whether Anthropic rejects it, shows that on Accounts, and warns early.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const { now } = await import("./db");
const { createAccount, listAccounts, loginWarnings, refreshAccountsSoon } = await import("./accounts");
const { fetchClaudeLimits } = await import("./usage");

const DAY = 86400_000;

/** A Claude account whose access token expires in `access` ms and whose login stops renewing in `refresh` ms. */
function account(name: string, access: number, refresh: number | null) {
  const a = createAccount("claude", name);
  const creds = (accessMs: number) =>
    writeFileSync(
      join(a.dir!, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "r", expiresAt: now() + accessMs, ...(refresh === null ? {} : { refreshTokenExpiresAt: now() + refresh }) } }),
    );
  creds(access);
  return { a, creds };
}

const view = (id: string) => {
  refreshAccountsSoon(); // listAccounts() caches for 10s
  return listAccounts().find((x) => x.id === id)!;
};
const status = (code: number) => (async () => new Response("{}", { status: code })) as unknown as typeof fetch;

test("a short-lived access token with a healthy login is fine: Claude Code renews it while a session runs", () => {
  const { a } = account("Short token", -60_000, 20 * DAY);
  const v = view(a.id);
  expect(v.logged_in).toBe(true);
  expect(v.login_problem).toBeNull();
  expect(loginWarnings([v]).filter((w) => w.id === a.id)).toEqual([]);
});

test("warns days ahead, with the date, while the login still works", () => {
  const { a } = account("Ending soon", 3600_000, 3 * DAY - 3600_000);
  const v = view(a.id);
  expect(v.logged_in).toBe(true);
  const [w] = loginWarnings([v]).filter((x) => x.id === a.id);
  expect(w!.title).toContain("Login ends soon");
  expect(w!.body).toContain("3 days");
});

test("once it has lapsed: signed out, with the reason, and one warning to sign in again", () => {
  const { a } = account("Lapsed", -3600_000, -DAY);
  const v = view(a.id);
  expect(v.logged_in).toBe(false);
  expect(v.login_problem).toBe("expired");
  expect(v.usage.note).toContain("lapsed");
  expect(loginWarnings([v]).find((x) => x.id === a.id)?.title).toContain("Sign in again");
});

test("a login with no recorded expiry (older credentials) is left alone", () => {
  const { a } = account("Unknown expiry", 3600_000, null);
  const v = view(a.id);
  expect(v.logged_in).toBe(true);
  expect(v.login_expires_at).toBeNull();
  expect(loginWarnings([v]).filter((x) => x.id === a.id)).toEqual([]);
});

test("Anthropic answering 401 to a token that hasn't expired marks the login rejected, until Claude Code renews it", async () => {
  const { a, creds } = account("Revoked", 3600_000, 20 * DAY);
  expect(view(a.id).logged_in).toBe(true);
  await fetchClaudeLimits(a.id, a.dir!, status(401));
  const v = view(a.id);
  expect(v.logged_in).toBe(false);
  expect(v.login_problem).toBe("rejected");
  expect(loginWarnings([v]).find((x) => x.id === a.id)?.kind).toBe("rejected");

  creds(7200_000); // Claude Code signed in / refreshed: a new token
  expect(view(a.id).login_problem).toBeNull();
  expect(view(a.id).logged_in).toBe(true);
});

test("other failures (429, 500) are not read as a bad login", async () => {
  const { a } = account("Busy server", 3600_000, 20 * DAY);
  await fetchClaudeLimits(a.id, a.dir!, status(429));
  expect(view(a.id).login_problem).toBeNull();
});
