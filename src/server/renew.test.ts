// Keeping Claude logins alive: just before an access token lapses, ask Claude Code (`claude auth status`) to
// renew it through its own locked refresh path. ansai never touches the token itself.
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { now } = await import("./db");
const { createAccount, listAccounts, refreshAccountsSoon } = await import("./accounts");
const { renewClaudeLogin, refreshRefused, RENEW_WITHIN_MS } = await import("./renew");

const MIN = 60_000;
const DAY = 86400_000;

function setup(name: string, accessMs: number, refreshMs: number | null = 20 * DAY) {
  const a = createAccount("claude", name);
  const write = (accessLeft: number) =>
    writeFileSync(
      join(a.dir!, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "r", expiresAt: now() + accessLeft, ...(refreshMs === null ? {} : { refreshTokenExpiresAt: now() + refreshMs }) } }),
    );
  write(accessMs);
  return { a, write };
}

const seen: { dir: string | null; debug: string }[] = [];
/** A stand-in for `claude auth status`: records the call, then does what `act` says. */
const fake = (act: (debugFile: string) => void = () => {}) => async (dir: string | null, debugFile: string) => {
  seen.push({ dir, debug: debugFile });
  act(debugFile);
};

test("leaves a token alone while there's plenty of time left", async () => {
  const { a } = setup("Plenty", 20 * MIN);
  seen.length = 0;
  expect(await renewClaudeLogin(a.id, a.dir!, true, fake())).toBe("skipped");
  expect(seen).toHaveLength(0);
});

test("asks Claude Code to renew a token about to lapse, in that account's own profile", async () => {
  const { a, write } = setup("Lapsing", RENEW_WITHIN_MS - MIN);
  seen.length = 0;
  const r = await renewClaudeLogin(a.id, a.dir!, true, fake(() => write(30 * MIN))); // what Claude Code does
  expect(r).toBe("renewed");
  expect(seen).toEqual([{ dir: a.dir!, debug: expect.any(String) }]);
  expect(existsSync(seen[0]!.debug)).toBe(false); // the scratch log is cleaned up
});

test("the normal login lives in ~/.claude, so no profile folder is named", async () => {
  const { a } = setup("Main login", 2 * MIN);
  seen.length = 0;
  await renewClaudeLogin(a.id, a.dir!, false, fake());
  expect(seen[0]!.dir).toBeNull();
});

test("an access token that already lapsed is renewed too (laptop was asleep)", async () => {
  const { a, write } = setup("Slept", -3 * 3600_000);
  expect(await renewClaudeLogin(a.id, a.dir!, true, fake(() => write(8 * 3600_000)))).toBe("renewed");
});

test("a login whose refresh token has lapsed is not attempted: only a sign-in helps", async () => {
  const { a } = setup("Lapsed login", -MIN, -DAY);
  seen.length = 0;
  expect(await renewClaudeLogin(a.id, a.dir!, true, fake())).toBe("skipped");
  expect(seen).toHaveLength(0);
});

test("signed out (no refresh token) is skipped", async () => {
  const a = createAccount("claude", "Signed out");
  seen.length = 0;
  expect(await renewClaudeLogin(a.id, a.dir!, true, fake())).toBe("skipped");
  expect(seen).toHaveLength(0);
});

test("when it can't renew (offline), it tries again in 10 minutes, not every minute, and says nothing about the login", async () => {
  const { a } = setup("Offline", MIN);
  seen.length = 0;
  const offline = fake((f) => writeFileSync(f, "[ERROR] OAuth refresh failed (expected): connect ECONNREFUSED"));
  expect(await renewClaudeLogin(a.id, a.dir!, true, offline)).toBe("failed");
  expect(await renewClaudeLogin(a.id, a.dir!, true, offline)).toBe("skipped");
  expect(seen).toHaveLength(1);
  refreshAccountsSoon();
  expect(listAccounts().find((x) => x.id === a.id)!.login_problem).toBeNull();
});

test("when Anthropic itself refuses the refresh, the account is flagged for a fresh sign-in, until it renews", async () => {
  const { a, write } = setup("Refused", MIN);
  const refused = fake((f) => writeFileSync(f, "[ERROR] OAuth refresh failed (expected): Request failed with status code 400"));
  expect(await renewClaudeLogin(a.id, a.dir!, true, refused)).toBe("refused");
  refreshAccountsSoon();
  const v = listAccounts().find((x) => x.id === a.id)!;
  expect(v.logged_in).toBe(false);
  expect(v.login_problem).toBe("rejected");

  write(8 * 3600_000); // signed in again: a new token
  refreshAccountsSoon();
  expect(listAccounts().find((x) => x.id === a.id)!.login_problem).toBeNull();
});

test("refreshRefused only trusts an HTTP answer from Anthropic", () => {
  expect(refreshRefused("OAuth refresh failed (expected): Request failed with status code 400")).toBe(true);
  expect(refreshRefused("OAuth refresh failed (expected): Request failed with status code 401")).toBe(true);
  expect(refreshRefused("OAuth refresh failed (expected): getaddrinfo ENOTFOUND platform.claude.com")).toBe(false);
  expect(refreshRefused("OAuth refresh failed (expected): timeout of 30000ms exceeded")).toBe(false);
  expect(refreshRefused("Request failed with status code 400")).toBe(false);
});
