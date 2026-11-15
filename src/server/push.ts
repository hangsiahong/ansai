import * as webpush from "web-push";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { db, now } from "./db";
import { badRequest, notFound } from "./errors";

/**
 * Web Push straight from the laptop to your phone/desktop browser (through the
 * browser vendor's push service). VAPID keys are generated once and kept in
 * ~/.ansai. Payloads only carry a title, a short body and a link.
 */

export type PushKind = "input" | "done" | "exited";
export type Prefs = Partial<Record<PushKind, boolean>>;

const keyFile = join(config.dataDir, "vapid.json");
function vapid(): { publicKey: string; privateKey: string } {
  if (existsSync(keyFile)) return JSON.parse(readFileSync(keyFile, "utf8"));
  const k = webpush.generateVAPIDKeys();
  writeFileSync(keyFile, JSON.stringify(k), { mode: 0o600 });
  return k;
}
const keys = vapid();
// The subject only tells push services who to contact about abuse; keep it generic.
webpush.setVapidDetails("mailto:ansai@example.com", keys.publicKey, keys.privateKey);

export const publicKey = () => keys.publicKey;

type SubRow = { endpoint: string; keys: string; prefs: string };

export function subscribe(sub: { endpoint?: unknown; keys?: unknown }, user: string, prefs: Prefs = {}) {
  const endpoint = String(sub?.endpoint ?? "");
  if (!/^https:\/\//.test(endpoint)) throw badRequest("bad push subscription");
  const k = sub.keys as { p256dh?: string; auth?: string } | undefined;
  if (!k?.p256dh || !k?.auth) throw badRequest("bad push subscription keys");
  db.query(
    `INSERT INTO push_subs (endpoint, keys, user, prefs, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, user = excluded.user, prefs = excluded.prefs`,
  ).run(endpoint, JSON.stringify({ p256dh: k.p256dh, auth: k.auth }), user, JSON.stringify(prefs), now());
}

export function unsubscribe(endpoint: string) {
  db.query("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint);
}

export function getPrefs(endpoint: string): Prefs | null {
  const r = db.query("SELECT prefs FROM push_subs WHERE endpoint = ?").get(endpoint) as { prefs: string } | null;
  return r ? JSON.parse(r.prefs) : null;
}

async function sendTo(row: SubRow, payload: object, urgency: "high" | "normal") {
  try {
    await webpush.sendNotification({ endpoint: row.endpoint, keys: JSON.parse(row.keys) }, JSON.stringify(payload), { TTL: 3600, urgency });
    db.query("UPDATE push_subs SET last_ok_at = ? WHERE endpoint = ?").run(now(), row.endpoint);
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) unsubscribe(row.endpoint); // browser dropped it
    else console.error("[ansai] push failed:", e?.statusCode ?? "", e?.body ?? e?.message ?? e);
  }
}

export async function notify(
  kind: PushKind,
  n: { title: string; body: string; url: string; tag?: string; session?: string; since?: number | null; actions?: { id: string; title: string; keys: string[] }[] },
) {
  const rows = db.query("SELECT endpoint, keys, prefs FROM push_subs").all() as SubRow[];
  const payload = { ...n, kind, tag: n.tag ?? n.url };
  await Promise.all(
    rows.filter((r) => JSON.parse(r.prefs)[kind] !== false).map((r) => sendTo(r, payload, kind === "input" ? "high" : "normal")),
  );
}

export async function testPush(endpoint: string) {
  const row = db.query("SELECT endpoint, keys, prefs FROM push_subs WHERE endpoint = ?").get(endpoint) as SubRow | null;
  if (!row) throw notFound("this device isn't subscribed");
  await sendTo(row, { title: "ansai", body: "Notifications work on this device.", url: "/", kind: "test", tag: "test" }, "normal");
}
