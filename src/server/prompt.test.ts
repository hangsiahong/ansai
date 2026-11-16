// Before ansai types into an agent and presses Enter by itself, it looks for the agent's
// input box. With a menu up instead, the text was thrown away and Enter picked a row.
// The screens are real captures (see test-screens.ts).
import { describe, expect, test } from "bun:test";

const { atPrompt, claudeRewound } = await import("./sessions");
const s = await import("./test-screens");

describe("is the agent's input box on screen?", () => {
  test("Claude: at its prompt, empty or with text in it, and mid-turn", () => {
    expect(atPrompt("claude", s.CLAUDE_IDLE)).toBe(true);
    expect(atPrompt("claude", s.CLAUDE_DRAFT)).toBe(true);
    expect(atPrompt("claude", s.CLAUDE_WORKING)).toBe(true);
    expect(atPrompt("claude", s.CLAUDE_IDLE + "\n\n\n")).toBe(true); // blank rows under it
  });

  test("Claude: not with a menu or a startup question up", () => {
    expect(atPrompt("claude", s.CLAUDE_MENU)).toBe(false);
    expect(atPrompt("claude", s.CLAUDE_TRUST)).toBe(false);
    expect(atPrompt("claude", "")).toBe(false);
  });

  test("Claude: not when the box has scrolled up behind something drawn under it", () => {
    const options = ["", " What do you want to do?", " ❯ 1. Stop and wait for the limit to reset", "   2. Switch to usage credits", "   3. Upgrade your plan", "", " Enter to confirm · Esc to cancel"].join("\n");
    expect(atPrompt("claude", s.CLAUDE_IDLE + options)).toBe(false);
  });

  test("Codex: at its prompt, with text in it, mid-turn, and after an interrupted turn", () => {
    expect(atPrompt("codex", s.CODEX_IDLE)).toBe(true);
    expect(atPrompt("codex", s.CODEX_DRAFT)).toBe(true);
    expect(atPrompt("codex", s.CODEX_WORKING)).toBe(true);
    expect(atPrompt("codex", s.CODEX_INTERRUPTED)).toBe(true);
  });

  test("Codex: not with a menu, a startup question or an approval up", () => {
    expect(atPrompt("codex", s.CODEX_MENU)).toBe(false);
    expect(atPrompt("codex", s.CODEX_TRUST)).toBe(false);
    expect(atPrompt("codex", "")).toBe(false);
    const approval = ["› run the tests", "", "  Would you like to run the following command?", "", "  $ bun test", "", "› 1. Yes, proceed (y)", "  2. No, and tell Codex what to do differently (esc)", "", "  Press enter to confirm or esc to cancel"].join("\n");
    expect(atPrompt("codex", approval)).toBe(false);
  });

  test("Codex: a list without numbers still isn't the prompt (its last line names enter and esc)", () => {
    const picker = ["› earlier message", "", "  Resume a previous session", "", "› fix the login page   2h ago", "  add dark mode        1d ago", "", "  enter to resume · esc to start new"].join("\n");
    expect(atPrompt("codex", picker)).toBe(false);
  });

  test("tools ansai has no screen for are never held", () => {
    expect(atPrompt("agy", "anything")).toBe(true);
    expect(atPrompt("shell", "")).toBe(true);
  });

  test("the rewind check still reads the same box", () => {
    expect(claudeRewound(s.CLAUDE_DRAFT)).toBe(true);
    expect(claudeRewound(s.CLAUDE_WORKING)).toBe(false); // nothing typed in it
  });
});
