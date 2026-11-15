// agy signed out: its sign-in screen is a startup dialog (Needs you, nothing auto-answered),
// and `agy models` tells Accounts and autopilot whether it's signed in.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { parseAgyModels, agySignedIn, noteAgySignedOut, parseLocked, noteKeyring, agySignInHint } = await import("./agyauth");
const { startupDialog } = await import("./sessions");

// agy 2026-11 when signed out (captured from a real session).
const SIGNED_OUT_SCREEN = [
  "     ▄▀▀▄",
  "    ▀▀▀▀▀▀",
  " Welcome to the Antigravity CLI. You are currently not signed in.",
  " Select login method:",
  " > 1. Google OAuth",
  "   2. Use a Google Cloud project",
  "   ↑/↓ Navigate · enter Select",
].join("\n");

describe("agy's sign-in screen", () => {
  test("is a startup dialog with no auto-answer and a message saying what to do", () => {
    const d = startupDialog("agy", SIGNED_OUT_SCREEN);
    expect(d?.kind).toBe("login");
    expect(d?.accept).toBeNull();
    expect(d?.acceptKeys).toEqual([]);
    expect(d?.message).toContain("Run `agy` in a terminal");
  });

  test("still found when a narrow (phone-width) terminal wraps its text", () => {
    const narrow = SIGNED_OUT_SCREEN.replace("You are currently not signed in.", "You are currently\n not signed in.");
    expect(startupDialog("agy", narrow)?.kind).toBe("login");
  });

  test("Claude's boxed trust question too, wrapped inside its border", () => {
    const boxed = "╭──────────────────────────────╮\n│ Is this a project you created │\n│ or one you trust?              │\n╰──────────────────────────────╯";
    expect(startupDialog("claude", boxed)?.kind).toBe("trust");
  });

  test("needs the menu, not just the words", () => {
    expect(startupDialog("agy", " You are currently not signed in.")).toBeNull();
  });

  test("this repo's own source on screen (say, a diff) doesn't trip it", () => {
    const src = readFileSync(join(import.meta.dir, "sessions.ts"), "utf8");
    expect(startupDialog("agy", src)).toBeNull();
  });
});

describe("parseAgyModels", () => {
  test("signed out: exit 1 and 'Please sign in' on stderr", () => {
    const err = "Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n";
    expect(parseAgyModels(1, "", err)).toEqual({ signedIn: false, models: [] });
  });

  test("signed in: the model list", () => {
    const out = "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";
    expect(parseAgyModels(0, out, "Fetching available models...\n")).toEqual({
      signedIn: true,
      models: [
        { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
      ],
    });
  });

  test("any other failure (offline, say) doesn't claim signed out", () => {
    expect(parseAgyModels(1, "", "Error: dial tcp: lookup example.com: no such host").signedIn).toBeNull();
  });
});

test("the sign-in screen marks the account signed out at once", () => {
  expect(agySignedIn("agy-test")).toBeNull();
  noteAgySignedOut("agy-test");
  expect(agySignedIn("agy-test")).toBe(false);
});

test("Accounts shows an agy account signed out, with what to do", async () => {
  const { db, now } = await import("./db");
  const { listAccounts, refreshAccountsSoon } = await import("./accounts");
  db.query("INSERT OR IGNORE INTO accounts (id, tool, name, dir, is_default, created_at) VALUES ('agy-default', 'agy', 'Default login', NULL, 1, ?)").run(now());
  noteAgySignedOut("agy-default");
  refreshAccountsSoon();
  const agy = listAccounts().find((a) => a.id === "agy-default")!;
  expect(agy.logged_in).toBe(false);
  expect(agy.usage.note).toContain("Run `agy` in a terminal");
});

describe("a locked desktop keyring", () => {
  // 2026-11-16: the keyring service restarted at 01:48, its "login" collection came back
  // locked, and every agy start looked signed out until it was unlocked; nothing had expired.
  test("busctl's answer for the collection's Locked property", () => {
    expect(parseLocked("b true\n")).toBe(true);
    expect(parseLocked("b false")).toBe(false);
    expect(parseLocked("")).toBeNull();
  });

  test("turns 'sign in again' into 'unlock the keyring', in Accounts too", async () => {
    const { listAccounts, refreshAccountsSoon } = await import("./accounts");
    try {
      noteKeyring(true);
      expect(agySignInHint()).toContain("keyring is locked");
      expect(agySignInHint()).toContain("no new Google sign-in");
      noteAgySignedOut("agy-default");
      refreshAccountsSoon();
      expect(listAccounts().find((a) => a.id === "agy-default")?.usage.note).toContain("keyring is locked");
      noteKeyring(false);
      expect(agySignInHint()).toContain("Run `agy` in a terminal");
    } finally {
      noteKeyring(null);
    }
  });
});
