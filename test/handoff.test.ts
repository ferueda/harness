import { expect, test } from "vitest";
import {
  assertNonEmptyHandoffStdin,
  assertNonEmptyHandoffText,
  assertPipedHandoffStdin,
} from "../lib/handoff.ts";

test("assertPipedHandoffStdin rejects tty stdin", () => {
  expect(() => assertPipedHandoffStdin(true)).toThrow(/requires piped stdin/);
});

test("assertPipedHandoffStdin accepts piped stdin", () => {
  expect(() => assertPipedHandoffStdin(false)).not.toThrow();
  expect(() => assertPipedHandoffStdin(undefined)).not.toThrow();
});

test("handoff stdin text must not be blank", () => {
  expect(() => assertNonEmptyHandoffStdin(" \n\t")).toThrow(/requires non-empty stdin/);
  expect(() => assertNonEmptyHandoffStdin("# Handoff\n")).not.toThrow();
});

test("inline handoff text must not be blank", () => {
  expect(() => assertNonEmptyHandoffText(" \n\t")).toThrow(/must not be empty/);
  expect(() => assertNonEmptyHandoffText("# Handoff\n")).not.toThrow();
});
