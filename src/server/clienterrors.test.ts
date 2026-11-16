import { beforeEach, describe, expect, test } from "bun:test";
import { clientErrorLine, resetClientErrors } from "./clienterrors";

beforeEach(resetClientErrors);

describe("errors reported by the web app", () => {
  test("become one log line that says the device, the place and the error", () => {
    const line = clientErrorLine("phone", { where: "page", route: "/s/abc", text: "TypeError: x is null\nat SessionPane (main.js)" });
    expect(line).toBe("[ansai] web app error on phone (page at /s/abc): TypeError: x is null | at SessionPane (main.js)");
  });

  test("can't forge a second log line or flood the log with one long error", () => {
    const line = clientErrorLine("phone\n[ansai] fake", { text: `boom\r\n[ansai] autopilot stopped\u0007${"x".repeat(5000)}` })!;
    expect(line.split("\n")).toHaveLength(1);
    expect(line).not.toContain("\u0007");
    expect(line.length).toBeLessThan(1500);
  });

  test("stop being logged after 20 in ten minutes, and start again later", () => {
    const at = 1_000_000;
    for (let i = 0; i < 20; i++) expect(clientErrorLine("phone", { text: "boom" }, at + i)).not.toBeNull();
    expect(clientErrorLine("phone", { text: "boom" }, at + 30)).toBeNull();
    expect(clientErrorLine("phone", { text: "boom" }, at + 11 * 60_000)).not.toBeNull();
  });
});
