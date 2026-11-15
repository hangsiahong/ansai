// A project's playbook reaches agents as system-level instructions, never as a prompt.
import { expect, test } from "bun:test";

const { db } = await import("./db");
const { setPlaybook } = await import("./team");
const { playbookNote, withHooks } = await import("./hooks");

test("Claude and Codex get the playbook with ansai's note; no playbook, no block", () => {
  db.query("INSERT OR IGNORE INTO projects (id, name, path, created_at) VALUES ('pb', 'pb', '/tmp/playbook-pb', 0)").run();
  expect(playbookNote("pb")).toBe("");
  setPlaybook("pb", "Run bun test before committing.");
  const note = playbookNote("pb");
  expect(note).toContain("Run bun test before committing.");

  const claude = withHooks("claude", ["claude", "do the thing"], "s1", note);
  expect(claude[claude.indexOf("--append-system-prompt") + 1]).toContain("Run bun test before committing.");
  expect(claude.filter((a) => a.includes("Run bun test")).length).toBe(1); // not in the prompt
  expect(claude.at(-1)).toBe("do the thing");

  const codex = withHooks("codex", ["codex"], "s1", note);
  expect(codex.find((a) => a.startsWith("developer_instructions="))).toContain("Run bun test before committing.");

  expect(withHooks("claude", ["claude"], "s1").join(" ")).not.toContain("playbook for this project");
  setPlaybook("pb", "");
});
