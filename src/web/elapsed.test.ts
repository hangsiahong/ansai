import { expect, test } from "bun:test";
import { elapsed } from "./elapsed";

test("how long an agent has been working reads as a short clock", () => {
  expect(elapsed(0)).toBe("0s");
  expect(elapsed(8_900)).toBe("8s");
  expect(elapsed(59_999)).toBe("59s");
  expect(elapsed(60_000)).toBe("1m 00s");
  expect(elapsed(134_000)).toBe("2m 14s");
  expect(elapsed(3_599_000)).toBe("59m 59s");
  expect(elapsed(3_900_000)).toBe("1h 05m");
  expect(elapsed(26 * 3_600_000 + 60_000)).toBe("26h 01m");
});

test("a phone whose clock is behind the server's never shows a negative time", () => {
  expect(elapsed(-4_000)).toBe("0s");
});
