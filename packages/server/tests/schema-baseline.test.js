import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = resolve(process.cwd(), "src/db/migrations");
const schemaSql = readFileSync(join(migrationsDir, "001_initial_schema.sql"), "utf8");

describe("001_initial_schema baseline", () => {
  it("is one baseline with only the tables the app uses", () => {
    const sql = schemaSql;
    const tables = [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)/g)]
      .map((m) => m[1])
      .sort();
    expect(tables).toEqual([
      "app_settings",
      "jobs",
      "qbo_connections",
      "refresh_tokens",
      "team_invites",
      "team_members",
      "teams",
      "users"
    ]);
  });

  it("enforces canonical emails with checks, triggers, and a functional index", () => {
    expect(schemaSql).toContain("CREATE FUNCTION normalize_email(input text)");
    expect(schemaSql).toContain("users_email_canonical_chk");
    expect(schemaSql).toContain("team_invites_email_canonical_chk");
    expect(schemaSql).toContain("CREATE FUNCTION trg_normalize_email_column()");
    expect(schemaSql).toContain("users_normalize_email_biur");
    expect(schemaSql).toContain("team_invites_normalize_email_biur");
    expect(schemaSql).toContain("idx_users_email_norm");
  });

  it("allows one active QBO job per team", () => {
    expect(schemaSql).toMatch(/CREATE UNIQUE INDEX jobs_one_active_qbo_job_per_team/);
  });

  it("has no plain index that a unique constraint or wider index already covers", () => {
    // Each entry: [name, table, columns, partial]. A b-tree on (a, b) serves every lookup on (a).
    const indexes = [];
    for (const [, table, body] of schemaSql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
      for (const [, name, cols] of body.matchAll(
        /CONSTRAINT (\w+) (?:PRIMARY KEY|UNIQUE) \(([^)]*)\)/g
      )) {
        indexes.push({ name, table, cols, partial: false, plain: false });
      }
    }
    for (const [, unique, name, table, cols, rest] of schemaSql.matchAll(
      /CREATE (UNIQUE )?INDEX (\w+) ON (\w+) \(([^;]*?)\)(\s+WHERE[^;]*)?;/g
    )) {
      indexes.push({ name, table, cols, partial: Boolean(rest), plain: !unique });
    }
    const columnsOf = (cols) => cols.split(",").map((c) => c.trim().replace(/\s+(ASC|DESC)$/i, ""));
    const redundant = [];
    for (const index of indexes.filter((i) => i.plain && !i.partial)) {
      const own = columnsOf(index.cols);
      const cover = indexes.find(
        (other) =>
          other !== index &&
          other.table === index.table &&
          !other.partial &&
          columnsOf(other.cols).length >= own.length &&
          own.every((col, i) => columnsOf(other.cols)[i] === col)
      );
      if (cover) redundant.push(`${index.name} (covered by ${cover.name})`);
    }
    expect(indexes.length).toBeGreaterThan(20);
    expect(redundant).toEqual([]);
  });

  it("seeds no data", () => {
    expect(schemaSql).not.toMatch(/\bINSERT INTO\b/i);
  });
});
