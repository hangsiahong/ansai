import { join } from "node:path";
import { getSetting, setSetting } from "./db";
import { readJsonFile } from "./files";

/**
 * Lean startup, per project and on unless you turn it off: a Claude agent ansai
 * starts leaves out what it loads from your own setup but doesn't use for coding,
 * and what every session pays for in its first request (~10k tokens of tool names
 * and server instructions):
 * - your claude.ai connectors (Gmail, Drive, Calendar, …), via Claude Code's
 *   `disableClaudeAiConnectors` setting;
 * - chat-channel plugins (Telegram, Discord, iMessage, …). Each one starts its own
 *   bot poller, a bot allows only one, and the newest replaces the poller of the
 *   session you actually chat through.
 * A project's own MCP servers (.mcp.json) and your other plugins still load.
 * Turned off, agents load everything your config loads, as in a terminal.
 */
export const isLean = (projectId: string | null | undefined): boolean => (projectId ? getSetting<boolean>(`lean:${projectId}`, true) : true);

export function setLean(projectId: string, on: boolean) {
  setSetting(`lean:${projectId}`, on);
}

/**
 * Installed plugins that describe themselves as a chat channel (the "channel"
 * keyword every official one carries: telegram, discord, imessage, fakechat), as
 * `name@marketplace`, from a Claude config folder's plugins/installed_plugins.json.
 * (An account profile links its plugins folder to ~/.claude's.)
 */
export function channelPlugins(configDir: string): string[] {
  const out = new Set<string>();
  const installed = readJsonFile(join(configDir, "plugins", "installed_plugins.json"))?.plugins;
  if (!installed || typeof installed !== "object") return [];
  for (const [id, entries] of Object.entries(installed)) {
    for (const e of Array.isArray(entries) ? entries : []) {
      if (typeof e?.installPath !== "string") continue;
      const keywords = readJsonFile(join(e.installPath, ".claude-plugin", "plugin.json"))?.keywords;
      if (Array.isArray(keywords) && keywords.includes("channel")) out.add(id);
    }
  }
  return [...out].sort();
}

/**
 * What lean startup adds to a Claude agent's --settings, next to ansai's hooks. These
 * settings outrank your own settings files (only managed settings beat them), so a
 * plugin enabled in a project's .claude/settings.json is turned off here too.
 */
export function leanSettings(configDir: string): { disableClaudeAiConnectors: true; enabledPlugins?: Record<string, false> } {
  const off = channelPlugins(configDir);
  return { disableClaudeAiConnectors: true, ...(off.length ? { enabledPlugins: Object.fromEntries(off.map((id) => [id, false as const])) } : {}) };
}
