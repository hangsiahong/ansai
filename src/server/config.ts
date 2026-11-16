import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";

const home = homedir();

function loginShell(): string {
  try {
    const me = userInfo().username;
    const line = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((l) => l.startsWith(me + ":"));
    const sh = line?.split(":")[6]?.trim();
    if (sh) return sh;
  } catch {}
  return process.env.SHELL || "/bin/bash";
}

const dataDir = process.env.ANSAI_HOME || join(home, ".ansai");
mkdirSync(dataDir, { recursive: true });

export const config = {
  home,
  dataDir,
  dbPath: join(dataDir, "ansai.db"),
  tmuxConf: join(dataDir, "tmux.conf"),
  tmuxSocket: process.env.ANSAI_TMUX_SOCKET || "ansai",
  port: Number(process.env.ANSAI_PORT || 7777),
  // Loopback only. Remote access goes through `tailscale serve`, never a public bind.
  hostname: "127.0.0.1",
  dev: !!process.env.ANSAI_DEV,
  // A folder with the built web app (what scripts/build-web.ts writes), used instead of
  // dist/web/<commit>. For tests; a release never sets it.
  webDist: process.env.ANSAI_WEB_DIST || "",
  shell: loginShell(),
  projectRoots: (process.env.ANSAI_ROOTS || join(home, "projects"))
    .split(":")
    .filter(Boolean),
  scanDepth: Number(process.env.ANSAI_SCAN_DEPTH || 4),
  // Extra Tailscale logins allowed besides the machine owner (comma separated).
  extraLogins: (process.env.ANSAI_ALLOWED_LOGINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  extraHosts: (process.env.ANSAI_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

// Lives in ./env so git.ts (which build scripts reach through webdist) doesn't run this file's mkdir.
export { cleanEnv } from "./env";
