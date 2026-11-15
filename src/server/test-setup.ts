// Preloaded by `bun test` (see bunfig.toml): tests never touch ~/.ansai, tmux or the network.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "ansai-test-"));
process.env.ANSAI_HOME = home;
process.env.ANSAI_PORT = "1"; // nothing listens there
process.env.ANSAI_TMUX_SOCKET = "ansai-test-none";
process.env.ANSAI_ALLOWED_LOGINS = "friend@example.com";
// In a preload, afterAll runs once, after every test file.
afterAll(() => rmSync(home, { recursive: true, force: true }));
