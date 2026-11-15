import { badRequest, tooLarge } from "./errors";

/**
 * Request bodies: read with a size cap, parse as JSON, then check against a
 * small schema. Every failure is a 400 (or 413) naming the field, so a bad
 * request never reaches the domain code as a half-typed object.
 */

export const JSON_LIMIT = 1024 * 1024;

const mb = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;

/** The raw JSON body, or undefined when there is none. Reads at most `limit` bytes. */
export async function readJson(req: Request, limit = JSON_LIMIT): Promise<unknown> {
  const tooBig = () => tooLarge(`request body must be ${mb(limit)} or smaller`);
  if (Number(req.headers.get("content-length")) > limit) throw tooBig();
  if (!req.body) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("request body is not valid JSON");
  }
}

/** Read the body and check it. A missing body counts as `{}`, so optional-only schemas accept it. */
export async function parseBody<T>(req: Request, check: Check<T>, limit = JSON_LIMIT): Promise<T> {
  return check((await readJson(req, limit)) ?? {}, "");
}

// ------------------------------------------------------------------- schema

/** Checks one value and returns it typed, or throws a 400 that names the field at `path`. */
export type Check<T> = (value: unknown, path: string) => T;
type Shape = Record<string, Check<unknown>>;
type Parsed<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const wrongType = (x: unknown, path: string, what: string) =>
  badRequest(x === undefined ? `${path} is required` : `${path} must be ${what}`);

export const v = {
  string:
    ({ min = 0, max, trim = false }: { min?: number; max: number; trim?: boolean }): Check<string> =>
    (x, path) => {
      if (typeof x !== "string") throw wrongType(x, path, "a string");
      const s = trim ? x.trim() : x;
      if (s.length < min) throw badRequest(min === 1 ? `${path} can't be empty` : `${path} must be at least ${min} characters`);
      if (s.length > max) throw badRequest(`${path} must be ${max} characters or fewer`);
      return s;
    },

  boolean: (): Check<boolean> => (x, path) => {
    if (typeof x !== "boolean") throw wrongType(x, path, "true or false");
    return x;
  },

  number:
    ({ min = -Infinity, max = Infinity, int = false }: { min?: number; max?: number; int?: boolean } = {}): Check<number> =>
    (x, path) => {
      if (typeof x !== "number" || !Number.isFinite(x)) throw wrongType(x, path, "a number");
      if (int && !Number.isInteger(x)) throw badRequest(`${path} must be a whole number`);
      if (x < min || x > max) throw badRequest(`${path} must be between ${min} and ${max}`);
      return x;
    },

  oneOf:
    <const T extends string>(values: readonly T[]): Check<T> =>
    (x, path) => {
      if (typeof x !== "string" || !(values as readonly string[]).includes(x)) throw wrongType(x, path, `one of ${values.join(", ")}`);
      return x as T;
    },

  array:
    <T>(item: Check<T>, { min = 0, max }: { min?: number; max: number }): Check<T[]> =>
    (x, path) => {
      if (!Array.isArray(x)) throw wrongType(x, path, "a list");
      if (x.length < min) throw badRequest(`${path} needs at least ${min} item${min === 1 ? "" : "s"}`);
      if (x.length > max) throw badRequest(`${path} can have at most ${max} items`);
      return x.map((el, i) => item(el, `${path}[${i}]`));
    },

  /** A JSON object with these fields. Unknown fields are dropped. */
  object:
    <S extends Shape>(shape: S): Check<Parsed<S>> =>
    (x, path) => {
      if (!isObject(x)) throw path ? wrongType(x, path, "an object") : badRequest("request body must be a JSON object");
      const out: Record<string, unknown> = {};
      for (const [k, check] of Object.entries(shape)) {
        const val = check(Object.hasOwn(x, k) ? x[k] : undefined, path ? `${path}.${k}` : k);
        if (val !== undefined) out[k] = val;
      }
      return out as Parsed<S>;
    },

  /** Any JSON object, fields unchecked (payloads that agent CLIs define). */
  anyObject: (): Check<Record<string, unknown>> => (x, path) => {
    if (!isObject(x)) throw path ? wrongType(x, path, "an object") : badRequest("request body must be a JSON object");
    return x;
  },

  optional:
    <T>(check: Check<T>): Check<T | undefined> =>
    (x, path) =>
      x === undefined ? undefined : check(x, path),

  nullable:
    <T>(check: Check<T>): Check<T | null> =>
    (x, path) =>
      x === null ? null : check(x, path),
};
