// Esc while Claude is still thinking rewinds: the prompt goes back into its input box,
// nothing is logged and no hook fires. The watcher spots that screen (and only that).
import { describe, expect, test } from "bun:test";

const { claudeRewound } = await import("./sessions");

const RULE = "─".repeat(120);
// Claude Code 2.1.325 after Esc during thinking (captured; note the no-break space after ❯).
const REWOUND = [
  " ▐▛███▛█   Claude Code v2.1.325",
  "▝▜██████▀  Opus 5.5 with max effort · Claude Ultra",
  RULE,
  "❯ Think very carefully before answering: how many primes are there below 10000, and what is the sum of the last ten of them? Work it out yourself without",
  "  tools.",
  RULE,
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
  "",
  "",
].join("\n");

describe("claudeRewound", () => {
  test("the rewound prompt in an idle input box", () => {
    expect(claudeRewound(REWOUND)).toBe(true);
  });

  test("never while a turn runs: Claude shows 'esc to interrupt'", () => {
    const thinking = REWOUND.replace("  ⏵⏵ auto mode on (shift+tab to cycle)", "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt");
    expect(claudeRewound(thinking)).toBe(false);
    const spinner = REWOUND.replace(RULE, `✻ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)\n${RULE}`);
    expect(claudeRewound(spinner)).toBe(false);
  });

  test("not a menu whose first line isn't the input (a permission or question dialog)", () => {
    const dialog = [RULE, " Bash command", "   rm -rf build", " Do you want to proceed?", "❯ 1. Yes", "  2. No", RULE, " Esc to cancel"].join("\n");
    expect(claudeRewound(dialog)).toBe(false);
  });

  test("not when the box isn't at the bottom of the screen", () => {
    expect(claudeRewound(REWOUND + "\n" + ["a", "b", "c", "d"].join("\n"))).toBe(false);
  });

  test("not an empty input line", () => {
    expect(claudeRewound(REWOUND.replace(/❯ Think[^\n]*\n {2}tools\./, "❯ "))).toBe(false);
  });
});
