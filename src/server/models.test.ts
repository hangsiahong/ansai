// The model picker's "Default" effort, and spotting an agent's answer to a typed /model or /effort.
import { describe, expect, test } from "bun:test";

const { claudeDefaultEffort, answeredOnScreen } = await import("./models");

// The QA report's settings: a global level plus per-model levels that win over it.
const settings = {
  model: "opus",
  effortLevel: "medium",
  modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh" }, "claude-opus-4-6": { effortLevel: "low" }, "claude-sonnet-5-5": { effortLevel: "high" } },
};

describe("claudeDefaultEffort", () => {
  test("an alias takes the newest model of its family's own level", () => {
    expect(claudeDefaultEffort(settings, "opus")).toBe("xhigh");
    expect(claudeDefaultEffort(settings, "sonnet")).toBe("high");
  });

  test("a model with no level of its own uses the global one", () => {
    expect(claudeDefaultEffort(settings, "haiku")).toBe("medium");
    expect(claudeDefaultEffort(settings, "claude-haiku-5-5")).toBe("medium");
  });

  test("what sessions actually ran on decides which model an alias means", () => {
    // The alias now points at a model with no entry yet: the global level applies, not an older model's.
    expect(claudeDefaultEffort(settings, "opus", ["claude-opus-4-6", "claude-opus-6-0"])).toBe("medium");
    expect(claudeDefaultEffort(settings, "opus", ["claude-opus-4-6", "claude-opus-5-5"])).toBe("xhigh");
  });

  test("full ids, including a [1m] suffix, look up their own entry", () => {
    expect(claudeDefaultEffort(settings, "claude-opus-5-5[1m]")).toBe("xhigh");
  });

  test("no settings means no known default", () => {
    expect(claudeDefaultEffort({}, "opus")).toBeNull();
  });
});

describe("answeredOnScreen", () => {
  const typed = ["❯ /model sonnet", "  ⎿  Set model to Sonnet 5.5", "❯ /effort medium"].join("\n");

  test("the latest echo of the command has an answer under it", () => {
    expect(answeredOnScreen(typed, "/model")).toBe(true);
  });

  test("a command still sitting there unanswered isn't confirmed", () => {
    expect(answeredOnScreen(typed, "/effort")).toBe(false);
  });

  test("an older answer to the same command doesn't count for a new one", () => {
    expect(answeredOnScreen(typed + "\n  ⎿  Set effort level to medium\n> /model sonnet", "/model")).toBe(false);
  });

  test("agy echoes the command without its argument; its answer counts too", () => {
    expect(answeredOnScreen("> /effort\n  ⎿  Effort set to low", "/effort")).toBe(true);
  });
});
