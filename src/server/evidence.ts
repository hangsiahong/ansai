import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { config } from "./config";

export type Evidence = { name: string; kind: "image" | "text"; size: number };

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".json": "text/plain; charset=utf-8",
  ".diff": "text/plain; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
};
export const EVIDENCE_MAX_FILES = 8;
export const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;
const ID = /^[a-z0-9]{1,40}$/i;
const NAME = /^[\w.-]{1,120}$/;

export const evidenceDir = (taskId: string, root = join(config.dataDir, "evidence")) => join(root, taskId);

type Picked = { src: string; name: string; kind: Evidence["kind"]; size: number };

/** Validates the agent's paths (relative to its working folder) before anything else runs, so a typo fails fast. */
export async function pickEvidence(paths: unknown, cwd: string): Promise<{ files: Picked[]; errors: string[] }> {
  if (paths === undefined || paths === null) return { files: [], errors: [] };
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) return { files: [], errors: ["evidence must be a list of file paths"] };
  if (paths.length > EVIDENCE_MAX_FILES) return { files: [], errors: [`at most ${EVIDENCE_MAX_FILES} evidence files`] };
  const files: Picked[] = [];
  const errors: string[] = [];
  for (const [i, raw] of (paths as string[]).entries()) {
    const p = raw.trim().replace(/^~(?=\/)/, config.home);
    if (!p) continue;
    const src = resolve(cwd, p);
    const ext = extname(src).toLowerCase();
    const type = TYPES[ext];
    if (!type) {
      errors.push(`${raw}: use a screenshot (.png .jpg .webp .gif) or a text log (.txt .log .md .json .diff .csv)`);
      continue;
    }
    const st = await stat(src).catch(() => null);
    if (!st?.isFile()) {
      errors.push(`${raw}: no such file (paths are relative to ${cwd})`);
      continue;
    }
    if (st.size > EVIDENCE_MAX_BYTES) {
      errors.push(`${raw}: ${Math.round(st.size / 1024 / 1024)} MB; keep each file under ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB`);
      continue;
    }
    const stem = basename(src, extname(src)).replace(/[^\w.-]/g, "_").slice(-80) || "evidence";
    files.push({ src, name: `${i + 1}-${stem}${ext}`, kind: type.startsWith("image/") ? "image" : "text", size: st.size });
  }
  return { files, errors };
}

/** Copies the files under ansai's data folder, so they outlive the worktree. Replaces the task's earlier evidence. */
export async function saveEvidence(taskId: string, files: Picked[], root?: string): Promise<Evidence[]> {
  if (!ID.test(taskId)) throw new Error("bad task id");
  const dir = evidenceDir(taskId, root);
  await rm(dir, { recursive: true, force: true });
  if (!files.length) return [];
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const f of files) await copyFile(f.src, join(dir, f.name));
  return files.map(({ name, kind, size }) => ({ name, kind, size }));
}

export async function dropEvidence(taskId: string, root?: string) {
  if (ID.test(taskId)) await rm(evidenceDir(taskId, root), { recursive: true, force: true }).catch(() => {}); // a leftover folder must not stop the task being deleted
}

export function evidenceFile(taskId: string, name: string, root?: string): { path: string; type: string } | null {
  if (!ID.test(taskId) || !NAME.test(name) || name.startsWith(".")) return null;
  const type = TYPES[extname(name).toLowerCase()];
  return type ? { path: join(evidenceDir(taskId, root), name), type } : null;
}

export function parseEvidence(raw: string | null): Evidence[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as Evidence[]) : [];
  } catch {
    return [];
  }
}
