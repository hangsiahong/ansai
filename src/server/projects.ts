import { readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, relative, resolve } from "node:path";
import { config } from "./config";
import { db, now } from "./db";
import { badRequest, notFound } from "./errors";
import { isLean, setLean } from "./lean";

export type Project = {
  id: string;
  name: string;
  path: string;
  pinned: number;
  hidden: number;
  created_at: number;
  last_used_at: number | null;
  autopilot: string | null;
};

const SKIP = new Set(["node_modules", "target", "dist", "build", "vendor", ".git", "venv", "__pycache__"]);

function slugFor(path: string): string {
  const rel = relative(config.home, path) || basename(path);
  return rel
    .replace(/^projects\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function findRepos(root: string, depth: number, out: string[]) {
  if (depth < 0) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.name === ".git")) {
    out.push(root);
    return; // don't descend into a repo
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name)) continue;
    findRepos(join(root, e.name), depth - 1, out);
  }
}

const upsert = db.query(
  `INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(path) DO NOTHING`,
);

export function scanProjects(): number {
  const found: string[] = [];
  for (const root of config.projectRoots) findRepos(root, config.scanDepth, found);
  const before = (db.query("SELECT count(*) AS n FROM projects").get() as { n: number }).n;
  db.transaction(() => {
    for (const p of found) addProjectRow(p);
  })();
  const after = (db.query("SELECT count(*) AS n FROM projects").get() as { n: number }).n;
  return after - before;
}

function addProjectRow(path: string): string {
  const existing = db.query("SELECT id FROM projects WHERE path = ?").get(path) as { id: string } | null;
  if (existing) return existing.id;
  let id = slugFor(path) || "project";
  let n = 1;
  while (db.query("SELECT 1 FROM projects WHERE id = ?").get(id)) id = `${slugFor(path)}-${++n}`;
  upsert.run(id, basename(path), path, now());
  return id;
}

export function addProject(rawPath: string): Project {
  const path = resolve(rawPath.replace(/^~(?=$|\/)/, config.home));
  if (!existsSync(path) || !statSync(path).isDirectory()) throw badRequest(`not a directory: ${path}`);
  const id = addProjectRow(path);
  db.query("UPDATE projects SET hidden = 0 WHERE id = ?").run(id);
  return getProject(id)!;
}

export function listProjects(includeHidden = false): (Project & { exists: boolean; lean: boolean })[] {
  const rows = db
    .query(
      `SELECT * FROM projects ${includeHidden ? "" : "WHERE hidden = 0"}
       ORDER BY pinned DESC, COALESCE(last_used_at, 0) DESC, name COLLATE NOCASE`,
    )
    .all() as Project[];
  return rows
    .map((r) => ({ ...r, autopilot: r.autopilot ? JSON.parse(r.autopilot) : null, lean: isLean(r.id), exists: existsSync(r.path) }))
    .filter((r) => r.exists || r.pinned);
}

export function getProject(id: string): Project | null {
  return db.query("SELECT * FROM projects WHERE id = ?").get(id) as Project | null;
}

export function updateProject(id: string, patch: { pinned?: boolean; hidden?: boolean; lean?: boolean }) {
  if (!getProject(id)) throw notFound("no such project");
  if (patch.pinned !== undefined) db.query("UPDATE projects SET pinned = ? WHERE id = ?").run(patch.pinned ? 1 : 0, id);
  if (patch.hidden !== undefined) db.query("UPDATE projects SET hidden = ? WHERE id = ?").run(patch.hidden ? 1 : 0, id);
  if (patch.lean !== undefined) setLean(id, patch.lean);
  return { ...getProject(id)!, lean: isLean(id) };
}

export function touchProject(id: string) {
  db.query("UPDATE projects SET last_used_at = ? WHERE id = ?").run(now(), id);
}
