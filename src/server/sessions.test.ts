// Restart picks an agent's conversation back up only while its prompt cache is warm.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resumableConversation, effectivePlaybook } = await import("./sessions");

const dir = mkdtempSync(join(tmpdir(), "ansai-resume-"));
const claudeLog = join(dir, "4f1c2d3e-aaaa-4bbb-8ccc-0123456789ab.jsonl");
const codexLog = join(dir, "rollout-2026-11-16T00-15-48-01a1e035-3e69-7be1-bb5f-1c7981eee15a.jsonl");
writeFileSync(claudeLog, "{}\n");
writeFileSync(codexLog, "{}\n");
const now = Date.now();

describe("resumableConversation", () => {
  test("reads the conversation id from Claude's and Codex's log names", () => {
    expect(resumableConversation({ tool: "claude", transcript: claudeLog }, now)).toBe("4f1c2d3e-aaaa-4bbb-8ccc-0123456789ab");
    expect(resumableConversation({ tool: "codex", transcript: codexLog }, now)).toBe("01a1e035-3e69-7be1-bb5f-1c7981eee15a");
  });
  test("starts fresh once the cache has gone cold (55 minutes)", () => {
    expect(resumableConversation({ tool: "claude", transcript: claudeLog }, now + 54 * 60_000)).not.toBeNull();
    expect(resumableConversation({ tool: "claude", transcript: claudeLog }, now + 56 * 60_000)).toBeNull();
  });
  test("nothing to resume: no log, a missing file, or a tool without conversations", () => {
    expect(resumableConversation({ tool: "claude", transcript: null }, now)).toBeNull();
    expect(resumableConversation({ tool: "claude", transcript: join(dir, "gone-0000.jsonl") }, now)).toBeNull();
    expect(resumableConversation({ tool: "agy", transcript: claudeLog }, now)).toBeNull();
  });
});

describe("effectivePlaybook", () => {
  test("empty guidance leaves launch behavior unchanged", () => {
    expect(effectivePlaybook("")).toBe("");
    expect(effectivePlaybook("  \n ")).toBe("");
  });
  test("identifies the ansai source and states precedence for agents", () => {
    const prompt = effectivePlaybook("Use the shared formatter.");
    expect(prompt).toContain("managed by ansai");
    expect(prompt).toContain("Use the shared formatter.");
    expect(prompt).toContain("Repository instruction files");
  });
});

describe("playbook delivery", () => {
  test("Claude and Codex get it as system-level instructions, never as a prompt", async () => {
    const { withHooks } = await import("./hooks");
    const pb = effectivePlaybook("Run bun test before committing.");
    const claude = withHooks("claude", ["claude"], "s1", pb);
    expect(claude[claude.indexOf("--append-system-prompt") + 1]).toContain("Run bun test before committing.");
    expect(claude.filter((a) => a.includes("Run bun test")).length).toBe(1); // only there, not as a prompt
    const codex = withHooks("codex", ["codex"], "s1", pb);
    expect(codex.find((a) => a.startsWith("developer_instructions="))).toContain("Run bun test before committing.");
    expect(withHooks("claude", ["claude"], "s1").join(" ")).not.toContain("Project playbook");
  });
});
