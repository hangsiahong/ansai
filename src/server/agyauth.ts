import { cleanEnv } from "./config";

/**
 * Whether agy is signed in, per account, from `agy models`: signed in, it lists
 * the models; signed out, it exits 1 with "Please sign in". One call feeds both
 * the model picker and this state, and is cached: a signed-in answer for 10
 * minutes, anything else for 1, so a fresh sign-in shows up soon. The session
 * watcher also marks an account signed out when agy shows its sign-in screen.
 * Key: the account id ("" when there are no agy accounts).
 */

export type AgyModels = { at: number; signedIn: boolean | null; models: { id: string; label: string }[] };

const cache = new Map<string, AgyModels>();
const inflight = new Map<string, Promise<AgyModels>>();
const TTL_IN = 10 * 60_000;
const TTL_OUT = 60_000;

/** Read `agy models`' answer. signedIn is null when it failed some other way (offline, say). */
export function parseAgyModels(code: number | null, out: string, err: string): Omit<AgyModels, "at"> {
  if (/please sign i[n]|not signed i[n]/i.test(`${out}\n${err}`)) return { signedIn: false, models: [] };
  const models: AgyModels["models"] = [];
  for (const line of out.split("\n")) {
    const [id, label] = line.split("\t");
    if (id && label && /^[\w.:-]+$/.test(id.trim())) models.push({ id: id.trim(), label: label.trim() });
  }
  return { signedIn: code === 0 && models.length > 0 ? true : null, models };
}

/** agy's models and sign-in state for an account; runs `agy models` only when the cached answer is stale. */
export function agyModels(key: string, env: () => Record<string, string>, force = false): Promise<AgyModels> {
  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.at < (hit.signedIn ? TTL_IN : TTL_OUT)) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (!p) {
    p = probe(key, env, hit).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function probe(key: string, env: () => Record<string, string>, prev: AgyModels | undefined): Promise<AgyModels> {
  if (!Bun.which("agy")) return { at: Date.now(), signedIn: null, models: [] };
  const p = Bun.spawn(["agy", "models"], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...cleanEnv(), ...env() } });
  const timer = setTimeout(() => p.kill(), 20_000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  const r = parseAgyModels(code, out, err);
  // A failed check (offline) keeps the last list, and says nothing new about the sign-in.
  const next = r.signedIn === null && prev ? { ...prev, at: Date.now(), signedIn: prev.signedIn === true ? null : prev.signedIn } : { at: Date.now(), ...r };
  cache.set(key, next);
  return next;
}

/** The last known answer: true, false (signed out), or null (not checked yet / couldn't tell). */
export function agySignedIn(key: string): boolean | null {
  return cache.get(key)?.signedIn ?? null;
}

/** agy showed its sign-in screen: it's signed out, whatever the cache said. */
export function noteAgySignedOut(key: string) {
  cache.set(key, { at: Date.now(), signedIn: false, models: cache.get(key)?.models ?? [] });
}
