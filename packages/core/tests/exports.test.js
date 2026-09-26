import { expect, it } from "vitest";
import * as core from "../src/index.js";

it("exports generate() as the entry point", () => {
  expect(typeof core.generate).toBe("function");
});
