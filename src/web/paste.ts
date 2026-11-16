/**
 * Files that reach a message without the file picker: pasted from the clipboard (a
 * screenshot, a copied image, a copied file), dropped on the session, or read from the
 * clipboard by the "Paste from clipboard" button for phones, whose keyboards do not
 * offer to paste a picture into a text box.
 */

// The same limits the server applies (the attachments route in server/index.ts).
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** The parts of a DataTransfer used here (a paste's clipboardData, a drop's dataTransfer). */
export type Transfer = {
  types: ArrayLike<string>;
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null;
  getData(type: string): string;
};

const WRAP = String.raw`(?:\s|<!--[\s\S]*?-->|</?(?:html|head|body|meta)\b[^>]*>)*`;
const LONE_IMG = new RegExp(`^${WRAP}<img\\b[^>]*>${WRAP}$`, "i");

/**
 * Copying cells from a spreadsheet or a paragraph from a document puts the text on the
 * clipboard together with a picture of it. That is a text paste. "Copy image" in a
 * browser also comes with HTML, but that HTML is only the <img> itself.
 */
export function isPictureOfText(plain: string, html: string): boolean {
  return plain.trim() !== "" && html.trim() !== "" && !LONE_IMG.test(html);
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/svg+xml": "svg", "text/plain": "txt" };
// What browsers call a pasted picture: "image.png", or nothing at all.
const NO_NAME = /^(?:image|blob|unknown|untitled)?(?:\.\w+)?$/i;
const two = (n: number) => String(n).padStart(2, "0");

/** Give a pasted file with no real name one that says what it is, and when it was pasted. */
export function named(file: File, at: Date, nth = 0): File {
  if (file.name && !NO_NAME.test(file.name)) return file;
  const ext = /\.(\w+)$/.exec(file.name)?.[1] ?? EXT[file.type] ?? /^\w+\/([a-z0-9]+)/i.exec(file.type)?.[1] ?? "bin";
  const kind = file.type.startsWith("image/") ? "pasted-image" : "pasted-file";
  const stamp = `${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  const name = `${kind}-${stamp}${nth ? `-${nth + 1}` : ""}.${ext.toLowerCase()}`;
  // The empty second part is for Bun (the tests): a File made from one File alone shares
  // its name with it there. Browsers do not need it, and it changes nothing for them.
  return new File([file, ""], name, { type: file.type, lastModified: file.lastModified });
}

/**
 * The files in a paste or a drop. Empty for a text paste, which the text box then handles
 * as it always did.
 */
export function transferFiles(data: Transfer | null | undefined, how: "paste" | "drop", at = new Date()): File[] {
  if (!data) return [];
  let files = Array.from(data.files ?? []);
  if (!files.length) {
    files = Array.from(data.items ?? [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
  }
  if (!files.length) return [];
  if (how === "paste" && files.every((f) => f.type.startsWith("image/"))) {
    const types = Array.from(data.types ?? []);
    if (types.includes("text/plain") && types.includes("text/html") && isPictureOfText(data.getData("text/plain"), data.getData("text/html"))) return [];
  }
  return files.map((f, i) => named(f, at, i));
}

/** True while something that carries files is being dragged over the page. */
export const carriesFiles = (data: { types: ArrayLike<string> } | null | undefined) => !!data && Array.from(data.types ?? []).includes("Files");

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

/** Add files to a message, within the limits. `note` says what was left out, if anything. */
export function addFiles(old: File[], picked: File[]): { files: File[]; note: string | null } {
  const files = [...old];
  const notes: string[] = [];
  let total = old.reduce((n, f) => n + f.size, 0);
  let full = false;
  for (const f of picked) {
    if (f.size > MAX_FILE_BYTES) notes.push(`${f.name} is over ${mb(MAX_FILE_BYTES)}`);
    else if (files.length >= MAX_FILES) full = true;
    else if (total + f.size > MAX_TOTAL_BYTES) notes.push(`${f.name} would take the message over ${mb(MAX_TOTAL_BYTES)}`);
    else {
      files.push(f);
      total += f.size;
    }
  }
  if (full) notes.push(`a message takes ${MAX_FILES} files at most`);
  return { files, note: notes.length ? `Left out: ${notes.join("; ")}` : null };
}

type ClipItem = { types: readonly string[]; getType(type: string): Promise<Blob> };

/**
 * Read the clipboard on request (a button, for phones). Pictures come back as files, and
 * anything else as text for the message box.
 */
export async function readClipboard(clip: { read(): Promise<ArrayLike<ClipItem>> }, at = new Date()): Promise<{ files: File[]; text: string }> {
  const files: File[] = [];
  let text = "";
  for (const item of Array.from(await clip.read())) {
    const plain = item.types.includes("text/plain") ? await (await item.getType("text/plain")).text() : "";
    const image = item.types.find((t) => t === "image/png") ?? item.types.find((t) => t.startsWith("image/"));
    const html = image && plain && item.types.includes("text/html") ? await (await item.getType("text/html")).text() : "";
    if (image && !isPictureOfText(plain, html)) files.push(named(new File([await item.getType(image)], "", { type: image }), at, files.length));
    else text += plain;
  }
  return { files, text };
}
