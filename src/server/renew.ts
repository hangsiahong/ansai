import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv } from "./config";
import { now } from "./db";
import { rejectLogin } from "./usage";

/**
 * Keep Claude logins alive without anyone having to sign in again.
 *
 * Claude's access token lasts hours, on some accounts 30 minutes, and only a running Claude Code session
 * renews it. An account nobody is using (a backup for when the main one hits its limit) just lets it lapse,
 * and the first sign of trouble is a prompt to sign in at the worst moment.
 *
 * Renewal rotates the refresh token, so two processes doing it at once can leave one holding a dead token.
 * Claude Code guards against that with a lock and by re-reading the credentials under it. We never touch the
 * token ourselves: just before it expires we run `claude auth status` in the account's profile, which renews
 * through that same path and does nothing when a session got there first.
 */

/** Claude Code renews when under 5 minutes are left; ask a little before that line. */
export const RENEW_WITHIN_MS = 4 * 60_000;
const RETRY_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 60_000;
const nextTry = new Map<string, number>();

type Creds = { refreshToken: boolean; expiresAt: number; refreshExpiresAt: number | null };

function readCreds(configDir: string): Creds | null {
  try {
    const c = JSON.parse(readFileSync(join(configDir, ".credentials.json"), "utf8"))?.claudeAiOauth;
    if (!c) return null;
    return { refreshToken: !!c.refreshToken, expiresAt: Number(c.expiresAt) || 0, refreshExpiresAt: Number(c.refreshTokenExpiresAt) || null };
  } catch {
    return null;
  }
}

/** Run `claude auth status` against a config folder; its debug log says how a renewal went. */
export type RunClaude = (configDir: string | null, debugFile: string) => Promise<void>;

const runClaude: RunClaude = async (configDir, debugFile) => {
  if (!Bun.which("claude")) return;
  const env = cleanEnv();
  delete env.CLAUDE_CONFIG_DIR; // the normal login lives in ~/.claude; only profiles name a folder
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  const p = Bun.spawn(["claude", "--debug-file", debugFile, "auth", "status"], { stdout: "ignore", stderr: "ignore", stdin: "ignore", env });
  const timer = setTimeout(() => p.kill(), RUN_TIMEOUT_MS);
  await p.exited;
  clearTimeout(timer);
};

/** True when the debug log shows Anthropic itself refusing the refresh (not a network failure). */
export const refreshRefused = (log: string) => /OAuth refresh failed[^\n]*status code (400|401)/.test(log);

export type Renewal = "skipped" | "renewed" | "failed" | "refused";

/**
 * Renew this account's login if the access token is about to lapse (or already has).
 * `configDir` is null for the normal login. Skipped when there's nothing to renew with.
 */
export async function renewClaudeLogin(accountId: string, configDir: string, isProfile: boolean, run: RunClaude = runClaude): Promise<Renewal> {
  const before = readCreds(configDir);
  if (!before?.refreshToken) return "skipped"; // signed out, or an API key
  if (before.refreshExpiresAt !== null && before.refreshExpiresAt < now()) return "skipped"; // lapsed: only a sign-in helps
  if (before.expiresAt - now() > RENEW_WITHIN_MS) return "skipped"; // plenty left
  if (now() < (nextTry.get(accountId) ?? 0)) return "skipped";
  nextTry.set(accountId, now() + RETRY_MS); // until it works

  const dir = mkdtempSync(join(tmpdir(), "ansai-renew-"));
  const debugFile = join(dir, "debug.log");
  try {
    await run(isProfile ? configDir : null, debugFile);
    const after = readCreds(configDir);
    if (after && after.expiresAt > before.expiresAt) {
      nextTry.delete(accountId);
      return "renewed";
    }
    let log = "";
    try {
      log = readFileSync(debugFile, "utf8");
    } catch {}
    if (refreshRefused(log) && (readCreds(configDir)?.expiresAt ?? 0) <= before.expiresAt) {
      rejectLogin(accountId, before.expiresAt);
      return "refused";
    }
    return "failed";
  } catch (e) {
    console.error(`[ansai] renewing ${accountId}: ${(e as Error).message}`);
    return "failed";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
