// Lean startup: Claude agents skip claude.ai connectors and chat-channel plugins, and get ansai's tools up front.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { db } = await import("./db");
const { channelPlugins, isLean, leanSettings } = await import("./lean");
const { withHooks, writeHookFiles } = await import("./hooks");
const { listProjects, updateProject } = await import("./projects");

/** A Claude config folder with these plugins installed, as Claude Code 2.1 records them. */
function configDir(plugins: Record<string, string[]>): string {
  const dir = mkdtempSync(join(process.env.ANSAI_HOME!, "lean-")); // removed with the test home
  mkdirSync(join(dir, "plugins"));
  const installed: Record<string, unknown[]> = {};
  for (const [id, keywords] of Object.entries(plugins)) {
    const path = join(dir, "plugins", "cache", id.replace("@", "/"), "1.0.0");
    mkdirSync(join(path, ".claude-plugin"), { recursive: true });
    writeFileSync(join(path, ".claude-plugin", "plugin.json"), JSON.stringify({ name: id.split("@")[0], keywords }));
    installed[id] = [{ scope: "user", installPath: path, version: "1.0.0" }];
  }
  writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: installed }));
  return dir;
}

const settingsOf = (argv: string[]) => JSON.parse(readFileSync(argv[argv.indexOf("--settings") + 1]!, "utf8"));
const mcpOf = (argv: string[]) => JSON.parse(argv[argv.indexOf("--mcp-config") + 1]!).mcpServers.ansai;

test("only plugins that call themselves a chat channel are picked out", () => {
  const dir = configDir({
    "telegram@claude-plugins-official": ["telegram", "messaging", "channel", "mcp"],
    "discord@claude-plugins-official": ["discord", "messaging", "channel", "mcp"],
    "easel@local": ["charts", "mcp"],
  });
  expect(channelPlugins(dir)).toEqual(["discord@claude-plugins-official", "telegram@claude-plugins-official"]);
  expect(channelPlugins(join(dir, "missing"))).toEqual([]);
  expect(leanSettings(configDir({ "easel@local": ["charts"] }))).toEqual({ disableClaudeAiConnectors: true });
});

test("a lean Claude agent gets the hooks plus the lean switches in one --settings", () => {
  const dir = configDir({ "telegram@claude-plugins-official": ["channel"], "easel@local": ["charts"] });
  const argv = withHooks("claude", ["claude", "fix the bug"], "s1", "", undefined, { lean: true, configDir: dir });
  expect(argv.filter((a) => a === "--settings").length).toBe(1); // Claude reads only the last one
  const s = settingsOf(argv);
  expect(s.disableClaudeAiConnectors).toBe(true);
  expect(s.enabledPlugins).toEqual({ "telegram@claude-plugins-official": false });
  expect(Object.keys(s.hooks)).toContain("Stop");
  expect(argv.at(-1)).toBe("fix the bug");
});

test("with lean startup off, the agent loads your full setup; ansai's tools are always up front", () => {
  writeHookFiles(); // the server writes the plain hooks file at startup
  const full = withHooks("claude", ["claude"], "s1", "", undefined, { lean: false });
  const s = settingsOf(full);
  expect(s.disableClaudeAiConnectors).toBeUndefined();
  expect(s.enabledPlugins).toBeUndefined();
  expect(mcpOf(full)).toMatchObject({ type: "http", alwaysLoad: true });
  expect(mcpOf(withHooks("claude", ["claude"], "s1", "", undefined, { lean: true, configDir: configDir({}) })).alwaysLoad).toBe(true);
});

test("lean startup is on per project unless turned off, and shows on the project", () => {
  db.query("INSERT OR IGNORE INTO projects (id, name, path, created_at) VALUES ('lean-p', 'lean-p', ?, 0)").run(tmpdir());
  expect(isLean("lean-p")).toBe(true);
  expect(isLean(null)).toBe(true); // sessions outside a project
  expect(updateProject("lean-p", { lean: false })?.lean).toBe(false);
  expect(isLean("lean-p")).toBe(false);
  expect(listProjects().find((p) => p.id === "lean-p")?.lean).toBe(false);
  updateProject("lean-p", { lean: true });
  expect(isLean("lean-p")).toBe(true);
});
