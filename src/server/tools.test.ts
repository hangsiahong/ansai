// A session's model and effort survive a restart: read back from its launch argv,
// and overridden by what it was last running (a live /model or /effort switch).
import { describe, expect, test } from "bun:test";

const { TOOLS, launchChoice, relaunchChoice } = await import("./tools");

describe("launchChoice", () => {
  test("reads back the flags each agent was launched with", () => {
    expect(launchChoice(TOOLS.claude.argv({ model: "opus", effort: "xhigh", yolo: true, prompt: "hi" }))).toEqual({ model: "opus", effort: "xhigh" });
    expect(launchChoice(TOOLS.codex.argv({ model: "gpt-6-luna", effort: "high", prompt: "hi" }))).toEqual({ model: "gpt-6-luna", effort: "high" });
    expect(launchChoice(TOOLS.agy.argv({ model: "gemini-3.8-flash-low", prompt: "hi" }))).toEqual({ model: "gemini-3.8-flash-low" });
  });

  test("finds them in a resumed Codex command too (codex resume <id> -m …)", () => {
    const fresh = TOOLS.codex.argv({ model: "gpt-6-sol", effort: "low" });
    expect(launchChoice([fresh[0]!, "resume", "01a1e035-3e69-7be1-bb5f-1c7981eee15a", ...fresh.slice(1)])).toEqual({ model: "gpt-6-sol", effort: "low" });
  });

  test("a launch without a pick has nothing to keep", () => {
    expect(launchChoice(TOOLS.claude.argv({ prompt: "--model" }))).toEqual({});
  });

  test("reviewer launches use each CLI's read-only mode", () => {
    expect(TOOLS.claude.argv({ prompt: "review", readOnly: true })).toContain("plan");
    expect(TOOLS.codex.argv({ prompt: "review", readOnly: true })).toContain("read-only");
  });
});

describe("relaunchChoice", () => {
  const launched = TOOLS.claude.argv({ model: "opus", effort: "low" });

  test("prefers what the session was last running over its launch flags", () => {
    expect(relaunchChoice(launched, { model: "claude-sonnet-5-5", effort: "high" })).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
  });

  test("maps the name Claude logs right after /model to its alias", () => {
    expect(relaunchChoice(launched, { model: "Haiku 5.5", effort: null })).toEqual({ model: "haiku", effort: "low" });
  });

  test("falls back to the launch flags when the log says nothing usable", () => {
    expect(relaunchChoice(launched, { model: null, effort: null })).toEqual({ model: "opus", effort: "low" });
    expect(relaunchChoice(launched, { model: "Some Model (Preview)", effort: "huge" })).toEqual({ model: "opus", effort: "low" });
  });
});
