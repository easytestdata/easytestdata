import { describe, expect, it } from "vitest";
import { EXTENSION_NAME, migrationTableName, validateExtensions } from "../src/extensions.js";

const reserved = [
  "auth",
  "connections",
  "jobs",
  "templates",
  "teams",
  "admin",
  "setup",
  "config",
  "health"
];

describe("extension descriptors", () => {
  it("exports the agreed name pattern and returns the original array", () => {
    expect(EXTENSION_NAME.source).toBe("^[a-z][a-z0-9-]{1,30}$");
    const extensions = [{ name: "demo-ext" }, Object.assign(Object.create(null), { name: "ab" })];
    expect(validateExtensions(extensions)).toBe(extensions);
    const empty = [];
    expect(validateExtensions(empty)).toBe(empty);
  });

  it.each([undefined, null, {}, "demo-ext", 1])("rejects a non-array: %s", (value) => {
    expect(() => validateExtensions(value)).toThrow(/array/i);
  });

  it.each([null, undefined, [], "demo-ext", 1, new Date(), Object.create({})])(
    "rejects a non-plain descriptor: %s",
    (value) => {
      expect(() => validateExtensions([value])).toThrow(/descriptor|plain/i);
    }
  );

  it.each([undefined, null, 1, "", "a", "A1", "1a", "demo_ext", "a".repeat(32), "ab;drop"])(
    "rejects an invalid name even without migrations: %s",
    (name) => {
      expect(() => validateExtensions([{ name }])).toThrow(/name/i);
      expect(() => migrationTableName(name)).toThrow(/name/i);
    }
  );

  it.each(["ab", "a1", "demo-ext", "a".repeat(31)])("accepts the name boundary: %s", (name) => {
    expect(validateExtensions([{ name }])).toEqual([{ name }]);
    expect(migrationTableName(name)).toBe(`_migrations_${name.replaceAll("-", "_")}`);
  });

  it.each(reserved)("rejects the reserved name %s", (name) => {
    expect(() => validateExtensions([{ name }])).toThrow(/reserved/i);
    expect(() => migrationTableName(name)).toThrow(/reserved/i);
  });

  it("rejects duplicate names and accepts distinct names", () => {
    expect(() => validateExtensions([{ name: "demo-ext" }, { name: "demo-ext" }])).toThrow(
      /duplicate/i
    );
    expect(validateExtensions([{ name: "demo-ext" }, { name: "other-ext" }])).toHaveLength(2);
  });

  for (const hook of ["router", "onStart", "onStopping", "onStop"]) {
    it(`accepts omitted, undefined and function ${hook}`, () => {
      for (const descriptor of [
        { name: "demo-ext" },
        { name: "demo-ext", [hook]: undefined },
        { name: "demo-ext", [hook]: () => {} }
      ]) {
        expect(validateExtensions([descriptor])).toEqual([descriptor]);
      }
    });

    it.each([null, false, 1, "function", {}])(`rejects non-function ${hook}: %s`, (value) => {
      expect(() => validateExtensions([{ name: "demo-ext", [hook]: value }])).toThrow(
        new RegExp(hook)
      );
    });
  }

  it("accepts omitted, undefined and non-empty migration directories", () => {
    for (const descriptor of [
      { name: "demo-ext" },
      { name: "demo-ext", migrationsDir: undefined },
      { name: "demo-ext", migrationsDir: "/tmp/demo-migrations" }
    ]) {
      expect(validateExtensions([descriptor])).toEqual([descriptor]);
    }
  });

  it.each([null, "", "   ", 1, false, {}])("rejects invalid migrationsDir: %s", (migrationsDir) => {
    expect(() => validateExtensions([{ name: "demo-ext", migrationsDir }])).toThrow(
      /migrationsDir/
    );
  });
});
