import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { db } from "./db";

/**
 * Files you attach to a message are saved here, one folder per session, for the agent to
 * read. They used to stay for good (until the laptop restarted and emptied /tmp); now a
 * session's folder goes when you close the session.
 */
export const ATTACH_ROOT = "/tmp/ansai-attachments";

// Session ids are made by ansai (letters and digits); anything else is not a folder of ours.
const ID = /^[a-z0-9]{6,40}$/i;

export const attachmentsDir = (sessionId: string, root = ATTACH_ROOT) => join(root, sessionId);

/** Remove a session's attached files. Never throws: a leftover folder is not worth failing a close for. */
export async function dropAttachments(sessionId: string, root = ATTACH_ROOT) {
  if (!ID.test(sessionId)) return;
  await rm(attachmentsDir(sessionId, root), { recursive: true, force: true }).catch(() => {});
}

/**
 * At start: remove the folders of sessions that were closed before this was cleaned up
 * (or while ansai was down). Only sessions this database knows as closed: another ansai
 * (a test instance) keeps its folders in the same place.
 */
export async function sweepAttachments(root = ATTACH_ROOT): Promise<number> {
  const names = await readdir(root).catch(() => [] as string[]);
  let n = 0;
  for (const name of names) {
    if (!ID.test(name)) continue;
    const s = db.query("SELECT status FROM sessions WHERE id = ?").get(name) as { status: string } | null;
    if (s?.status !== "closed") continue;
    await dropAttachments(name, root);
    n++;
  }
  return n;
}
