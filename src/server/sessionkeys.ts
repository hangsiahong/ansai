import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db";

/**
 * A secret key for each session, so a hook or tool call that says "I am session X" can
 * be believed. The session id alone used to be enough, and list_agents hands every agent
 * its teammates' ids: one agent could send a message recorded as another, or drain
 * another's inbox with a made-up hook call.
 *
 * The key reaches the agent only through its environment (ANSAI_SESSION_KEY): never on a
 * command line, in the hooks file, or in anything the API returns. It lives in its own
 * table so no query for a session row can carry it along by accident. A process that
 * goes digging in another's environment can still find it; this stops the calls an agent
 * can make with what it is given, not a break-in.
 */

/** The environment variable the agent's hooks and its tool server connection read. */
export const KEY_ENV = "ANSAI_SESSION_KEY";

/** This session's key, made the first time it is asked for (before the agent starts). */
export function sessionKey(sessionId: string): string {
  const have = db.query("SELECT token FROM session_keys WHERE session_id = ?").get(sessionId) as { token: string } | null;
  if (have) return have.token;
  const token = randomBytes(24).toString("base64url");
  db.query("INSERT INTO session_keys (session_id, token) VALUES (?, ?)").run(sessionId, token);
  return token;
}

export function hasSessionKey(sessionId: string): boolean {
  return !!db.query("SELECT 1 FROM session_keys WHERE session_id = ?").get(sessionId);
}

/** Forget a key whose session never started. */
export function dropSessionKey(sessionId: string) {
  db.query("DELETE FROM session_keys WHERE session_id = ?").run(sessionId);
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Whether a call for this session may go ahead. With a key on file, the caller must show
 * it. A session with none was started before keys existed: its agent is still running
 * and can't be given one, so it is believed as before, until it is restarted. An id
 * ansai has never seen is refused.
 */
export function callerAllowed(sessionId: string, shown: string | null): boolean {
  if (!sessionId) return false;
  const have = db.query("SELECT token FROM session_keys WHERE session_id = ?").get(sessionId) as { token: string } | null;
  if (have) return !!shown && timingSafeEqual(digest(shown), digest(have.token));
  return !!db.query("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
}

/** The key a request shows: `Authorization: Bearer <key>`. */
export function shownKey(req: Request): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1]! : null;
}
