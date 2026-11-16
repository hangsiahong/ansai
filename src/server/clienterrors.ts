/**
 * Errors from the web app, written to ansai's log. A page that breaks on the phone has no
 * console to read; this puts what broke where `journalctl --user -u ansai` shows it.
 */

const WINDOW = 10 * 60_000;
const MAX = 20;
let times: number[] = [];

/** One line for the log (null: too many in the last ten minutes, e.g. a page failing in a loop). */
export function clientErrorLine(device: string, e: { where?: string; route?: string; text: string }, at = Date.now()): string | null {
  times = times.filter((t) => at - t < WINDOW);
  if (times.length >= MAX) return null;
  times.push(at);
  // One line per error, and nothing in it can pose as another log line.
  const flat = (s: string, max: number) => s.replace(/\s*\n\s*/g, " | ").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max);
  return `[ansai] web app error on ${flat(device || "a device", 80)} (${flat(e.where ?? "?", 20)} at ${flat(e.route ?? "?", 120)}): ${flat(e.text, 1200)}`;
}

/** Tests: start counting from nothing. */
export function resetClientErrors() {
  times = [];
}
