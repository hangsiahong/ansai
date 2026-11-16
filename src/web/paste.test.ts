import { describe, expect, test } from "bun:test";
import { MAX_FILE_BYTES, addFiles, carriesFiles, isPictureOfText, named, readClipboard, transferFiles, type Transfer } from "./paste";

const at = new Date(2026, 10, 16, 9, 5, 7);
const png = (name = "image.png", size = 4) => new File([new Uint8Array(size)], name, { type: "image/png" });

function transfer(o: { files?: File[]; items?: File[]; data?: Record<string, string> }): Transfer {
  const data = o.data ?? {};
  const all = [...(o.files ?? []), ...(o.items ?? [])];
  return {
    types: [...Object.keys(data), ...(all.length ? ["Files"] : [])],
    files: o.files ?? [],
    items: [
      ...Object.keys(data).map(() => ({ kind: "string", getAsFile: () => null })),
      ...all.map((f) => ({ kind: "file", getAsFile: () => f })),
    ],
    getData: (type) => data[type] ?? "",
  };
}

describe("a paste into a session", () => {
  test("a screenshot becomes a file named for what it is and when it was pasted", () => {
    const [f] = transferFiles(transfer({ files: [png()] }), "paste", at);
    expect(f!.name).toBe("pasted-image-090507.png");
    expect(f!.type).toBe("image/png");
    expect(f!.size).toBe(4);
  });

  test("plain text is left to the text box", () => {
    expect(transferFiles(transfer({ data: { "text/plain": "hello" } }), "paste", at)).toEqual([]);
    expect(transferFiles(null, "paste", at)).toEqual([]);
  });

  test("a copied file keeps its own name", () => {
    const report = new File(["a,b"], "report.csv", { type: "text/csv" });
    // A file manager also puts the file's path on the clipboard as text.
    const got = transferFiles(transfer({ files: [report], data: { "text/plain": "/home/me/report.csv" } }), "paste", at);
    expect(got.map((f) => f.name)).toEqual(["report.csv"]);
  });

  test("files a browser only lists under items are found too", () => {
    const got = transferFiles(transfer({ items: [png("")] }), "paste", at);
    expect(got.map((f) => f.name)).toEqual(["pasted-image-090507.png"]);
  });

  test("several unnamed pictures in one paste get different names", () => {
    const jpg = new File(["x"], "image.jpeg", { type: "image/jpeg" });
    const got = transferFiles(transfer({ files: [png(), jpg] }), "paste", at);
    expect(got.map((f) => f.name)).toEqual(["pasted-image-090507.png", "pasted-image-090507-2.jpeg"]);
  });

  test("cells copied from a spreadsheet paste as text, not as the picture of them", () => {
    const data = { "text/plain": "a\tb\n1\t2", "text/html": "<table><tr><td>a</td><td>b</td></tr></table>" };
    expect(transferFiles(transfer({ files: [png()], data }), "paste", at)).toEqual([]);
  });

  test("an image copied from a web page is attached, though it comes with HTML", () => {
    const html = '<meta charset="utf-8"><img src="https://example.com/cat.png" alt="cat">';
    expect(transferFiles(transfer({ files: [png()], data: { "text/html": html } }), "paste", at)).toHaveLength(1);
    // Some browsers add the image's address as text as well.
    const both = { "text/html": `<html><body><!--StartFragment-->${html}<!--EndFragment--></body></html>`, "text/plain": "https://example.com/cat.png" };
    expect(transferFiles(transfer({ files: [png()], data: both }), "paste", at)).toHaveLength(1);
  });

  test("a drop always takes the files, whatever else is dragged along", () => {
    const data = { "text/plain": "https://example.com/a", "text/html": "<a href='https://example.com/a'>a <b>link</b></a>" };
    expect(transferFiles(transfer({ files: [png("photo.png")], data }), "drop", at).map((f) => f.name)).toEqual(["photo.png"]);
  });

  test("only a drag that carries files is treated as a drop of files", () => {
    expect(carriesFiles({ types: ["Files"] })).toBe(true);
    expect(carriesFiles({ types: ["text/plain"] })).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });
});

describe("naming a pasted file", () => {
  test("names a browser made up are replaced, real ones are kept", () => {
    expect(named(png("image.png"), at).name).toBe("pasted-image-090507.png");
    expect(named(png(""), at).name).toBe("pasted-image-090507.png");
    expect(named(png("Screenshot 2026-11-16.png"), at).name).toBe("Screenshot 2026-11-16.png");
    expect(named(png("image-of-cat.png"), at).name).toBe("image-of-cat.png");
  });

  test("the ending comes from the file's type when it has no name", () => {
    expect(named(new File(["x"], "", { type: "image/jpeg" }), at).name).toBe("pasted-image-090507.jpg");
    expect(named(new File(["x"], "", { type: "image/svg+xml" }), at).name).toBe("pasted-image-090507.svg");
    expect(named(new File(["x"], "", { type: "application/pdf" }), at).name).toBe("pasted-file-090507.pdf");
    expect(named(new File(["x"], ""), at).name).toBe("pasted-file-090507.bin");
  });
});

describe("the limits of one message", () => {
  test("files are added after the ones already there", () => {
    const r = addFiles([png("a.png")], [png("b.png")]);
    expect(r.files.map((f) => f.name)).toEqual(["a.png", "b.png"]);
    expect(r.note).toBeNull();
  });

  test("a sixth file is left out, and you are told", () => {
    const five = [1, 2, 3, 4, 5].map((n) => png(`${n}.png`));
    const r = addFiles(five, [png("6.png"), png("7.png")]);
    expect(r.files).toHaveLength(5);
    expect(r.note).toBe("Left out: a message takes 5 files at most");
  });

  test("a file over 20 MB is left out by name, the rest are kept", () => {
    const r = addFiles([], [png("huge.png", MAX_FILE_BYTES + 1), png("ok.png")]);
    expect(r.files.map((f) => f.name)).toEqual(["ok.png"]);
    expect(r.note).toBe("Left out: huge.png is over 20 MB");
  });

  test("files that together pass 50 MB stop at the one that would go over", () => {
    const big = (n: string) => png(n, 19 * 1024 * 1024);
    const r = addFiles([], [big("a"), big("b"), big("c"), png("small.png")]);
    expect(r.files.map((f) => f.name)).toEqual(["a", "b", "small.png"]);
    expect(r.note).toBe("Left out: c would take the message over 50 MB");
  });
});

describe("the Paste from clipboard button", () => {
  const item = (parts: Record<string, string>) => ({
    types: Object.keys(parts),
    getType: async (type: string) => new Blob([parts[type]!], { type }),
  });
  const clip = (...items: ReturnType<typeof item>[]) => ({ read: async () => items });

  test("a copied picture comes back as a file", async () => {
    const r = await readClipboard(clip(item({ "image/png": "PNGDATA" })), at);
    expect(r.files.map((f) => [f.name, f.type, f.size])).toEqual([["pasted-image-090507.png", "image/png", 7]]);
    expect(r.text).toBe("");
  });

  test("copied text comes back as text for the message box", async () => {
    const r = await readClipboard(clip(item({ "text/plain": "hello there", "text/html": "<b>hello there</b>" })), at);
    expect(r).toEqual({ files: [], text: "hello there" });
  });

  test("a picture of copied text is read as the text", async () => {
    const r = await readClipboard(clip(item({ "text/plain": "a\tb", "text/html": "<table><tr><td>a</td><td>b</td></tr></table>", "image/png": "PNG" })), at);
    expect(r).toEqual({ files: [], text: "a\tb" });
  });

  test("an image copied from a web page is a file, not its address", async () => {
    const r = await readClipboard(clip(item({ "text/plain": "https://example.com/cat.png", "text/html": '<img src="https://example.com/cat.png">', "image/png": "PNG" })), at);
    expect(r.files).toHaveLength(1);
    expect(r.text).toBe("");
  });

  test("png is preferred when a picture is offered in several formats", async () => {
    const r = await readClipboard(clip(item({ "image/webp": "W", "image/png": "PN" })), at);
    expect(r.files[0]!.type).toBe("image/png");
  });

  test("an empty clipboard gives nothing, and a refusal is passed on", async () => {
    expect(await readClipboard(clip(), at)).toEqual({ files: [], text: "" });
    const refused = { read: async () => Promise.reject(new DOMException("denied", "NotAllowedError")) };
    expect(readClipboard(refused, at)).rejects.toThrow("denied");
  });
});

test("only a lone image tag counts as a copied image", () => {
  expect(isPictureOfText("x", "<p>x</p>")).toBe(true);
  expect(isPictureOfText("x", " <img src='a.png'> ")).toBe(false);
  expect(isPictureOfText("x", "<p>see <img src='a.png'></p>")).toBe(true);
  expect(isPictureOfText("", "<p>x</p>")).toBe(false);
  expect(isPictureOfText("x", "")).toBe(false);
});
