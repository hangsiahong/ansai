import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";

/** The parsed file, or null when it is missing, unreadable or not JSON. */
export function readJsonFile(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Hand every complete line of `path` from `start` up to `end` (the file's size by default) to `onLine`,
 * with the line's place in the file, and return the place just past the last line handed over (null when
 * none was). `skipFirst` drops the piece of a line that a mid-file `start` lands in.
 *
 * Logs reach hundreds of MB, so they go through one `slice`-sized buffer with a pause between slices for
 * sockets; lines are split on the newline byte before decoding, so a character cut by a slice edge is whole.
 * `line` is only valid during the call: the buffer under it is reused.
 */
export async function eachLine(
  path: string,
  start: number,
  onLine: (line: Buffer, at: number) => void,
  { end = Bun.file(path).size, skipFirst = false, slice = 1024 * 1024 }: { end?: number; skipFirst?: boolean; slice?: number } = {},
): Promise<number | null> {
  if (end <= start) return null;
  const fh = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(Math.min(slice, end - start));
    let carry: Buffer[] = []; // the start of a line that runs on into the next slice
    let skip = skipFirst;
    let lineAt = start;
    let last: number | null = null;
    for (let at = start; at < end; ) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - at), at);
      if (!bytesRead) break; // the file got shorter under us
      const chunk = buf.subarray(0, bytesRead);
      let pos = 0;
      for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, pos)) {
        if (skip) skip = false;
        else {
          const piece = chunk.subarray(pos, nl);
          onLine(carry.length ? Buffer.concat([...carry, piece]) : piece, lineAt);
          last = at + nl + 1;
        }
        carry = [];
        pos = nl + 1;
        lineAt = at + pos;
      }
      if (pos < bytesRead && !skip) carry.push(Buffer.from(chunk.subarray(pos)));
      at += bytesRead;
      if (at < end) await Bun.sleep(1);
    }
    return last;
  } finally {
    await fh.close();
  }
}
