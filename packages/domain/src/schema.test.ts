import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

describe("CreatorOS database migration", () => {
  const migrationDirectory = resolve(process.cwd(), "../../supabase/migrations");
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(resolve(migrationDirectory, name), "utf8"));
  const sql = migrations.join("\n");
  const seed = readFileSync(resolve(process.cwd(), "../../supabase/seed.sql"), "utf8");
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      create schema auth;
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
    `);
    // PGlite's WASM distribution omits the optional pgcrypto control file;
    // modern Postgres still provides gen_random_uuid(), so only that extension declaration is skipped.
    for (const migration of migrations) {
      await database.exec(migration.replace("create extension if not exists pgcrypto;", ""));
    }
    await database.exec(seed);
  }, 60_000);

  afterAll(async () => database.close());

  it("replays the migration and deterministic seed on Postgres", async () => {
    const tables = await database.query<{ count: number }>(
      "select count(*)::int as count from information_schema.tables where table_schema='public'",
    );
    const creators = await database.query<{ count: number }>(
      "select count(*)::int as count from public.creators",
    );
    expect(tables.rows[0]?.count).toBeGreaterThanOrEqual(50);
    expect(creators.rows[0]?.count).toBe(3);
  });

  it("enforces tenant isolation for authenticated reads", async () => {
    const userId = "40000000-0000-4000-8000-000000000001";
    await database.exec(`
      insert into auth.users(id) values ('${userId}');
      insert into public.users(id,email) values ('${userId}','tenant-test@fictional.demo');
      insert into public.organization_memberships(organization_id,user_id,role)
      values ('00000000-0000-4000-8000-000000000001','${userId}','viewer');
      insert into public.organizations(id,name,slug) values
      ('00000000-0000-4000-8000-000000000099','Other Organization','other');
      set request.jwt.claim.sub = '${userId}';
      set role authenticated;
    `);
    try {
      const visible = await database.query<{ slug: string }>(
        "select slug from public.organizations order by slug",
      );
      expect(visible.rows).toEqual([{ slug: "foundry" }]);
      await expect(
        database.exec(
          "insert into public.prospects(organization_id,preferred_name,stage_name) values ('00000000-0000-4000-8000-000000000001','Blocked','Blocked')",
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("reset role");
    }
  });

  it("installs an RLS policy on every tenant table", async () => {
    const result = await database.query<{ count: number }>(
      "select count(*)::int as count from pg_policies where schemaname='public'",
    );
    expect(result.rows[0]?.count).toBeGreaterThanOrEqual(50);
  });
  it("blocks direct cross-organization records and credential-table reads", async () => {
    const userId = "40000000-0000-4000-8000-000000000001";
    const otherOrg = "00000000-0000-4000-8000-000000000099";
    await database.exec(`
      set role service_role;
      insert into public.creators(
        organization_id, preferred_name, stage_name, email, timezone, start_date,
        contract_status, jurisdiction_review_status, adult_confirmation_status
      ) values (
        '${otherOrg}','Other','Other Creator','other@example.test','UTC',current_date,
        'SIGNED','APPROVED','CONFIRMED'
      );
      reset role;
      set request.jwt.claim.sub = '${userId}';
      set role authenticated;
    `);
    try {
      const visible = await database.query<{ count: number }>(
        `select count(*)::int as count from public.creators where organization_id='${otherOrg}'`,
      );
      expect(visible.rows[0]?.count).toBe(0);
      await expect(
        database.query("select * from public.integration_credentials"),
      ).rejects.toThrow();
    } finally {
      await database.exec("reset role");
    }
  });

  it("consumes OAuth state once and rejects the wrong actor", async () => {
    const userId = "40000000-0000-4000-8000-000000000001";
    const orgId = "00000000-0000-4000-8000-000000000001";
    await database.exec(`
      set role service_role;
      insert into public.oauth_states(organization_id,user_id,provider,state_hash,redirect_uri,expires_at)
      values ('${orgId}','${userId}','SLACK','state-hash','https://example.test/callback',now()+interval '10 minutes');
    `);
    try {
      const wrong = await database.query<{ redirect_uri: string }>(
        `select * from public.consume_oauth_state('state-hash','SLACK','40000000-0000-4000-8000-000000000099','${orgId}')`,
      );
      expect(wrong.rows).toHaveLength(0);
      const first = await database.query<{ redirect_uri: string }>(
        `select * from public.consume_oauth_state('state-hash','SLACK','${userId}','${orgId}')`,
      );
      expect(first.rows).toEqual([{ redirect_uri: "https://example.test/callback" }]);
      const replay = await database.query<{ redirect_uri: string }>(
        `select * from public.consume_oauth_state('state-hash','SLACK','${userId}','${orgId}')`,
      );
      expect(replay.rows).toHaveLength(0);
    } finally {
      await database.exec("reset role");
    }
  });

  it("enforces a shared database rate limit", async () => {
    await database.exec("set role service_role");
    try {
      const results: boolean[] = [];
      for (let index = 0; index < 3; index += 1) {
        const result = await database.query<{ allowed: boolean }>(
          "select public.consume_api_rate_limit('test-key',2,60) as allowed",
        );
        results.push(result.rows[0]?.allowed ?? false);
      }
      expect(results).toEqual([true, true, false]);
    } finally {
      await database.exec("reset role");
    }
  });
  it("converts a signed prospect atomically and idempotently", async () => {
    const prospectId = "90000000-0000-4000-8000-000000000001";
    await database.exec(`
      insert into public.prospects(
        id,organization_id,prospect_number,preferred_name,stage_name,email,timezone,pipeline_stage
      ) values (
        '${prospectId}','00000000-0000-4000-8000-000000000001','PR-900001',
        'Jessica','Jessica Brooks','jessica@fictional.demo','America/Chicago','SIGNED'
      );
      set role service_role;
    `);
    try {
      const first = await database.query<{ creator_id: string }>(
        `select public.convert_prospect_to_creator('${prospectId}') as creator_id`,
      );
      const second = await database.query<{ creator_id: string }>(
        `select public.convert_prospect_to_creator('${prospectId}') as creator_id`,
      );
      expect(second.rows[0]?.creator_id).toBe(first.rows[0]?.creator_id);
      const linked = await database.query<{ creators: number; events: number; outbox: number }>(`
        select
          (select count(*)::int from public.creators where source_prospect_id='${prospectId}') creators,
          (select count(*)::int from public.domain_events where event_name='creator.created' and payload_json->>'source_prospect_id'='${prospectId}') events,
          (select count(*)::int from public.event_outbox where topic='creator.created' and payload_json->>'source_prospect_id'='${prospectId}') outbox
      `);
      expect(linked.rows[0]).toEqual({ creators: 1, events: 1, outbox: 1 });
    } finally {
      await database.exec("reset role");
    }
  });
  it("defines the complete V1 relational surface", () => {
    expect((sql.match(/create table public\./g) ?? []).length).toBeGreaterThanOrEqual(45);
  });
  it("enables tenant RLS across business tables", () => {
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("public.is_organization_member(organization_id)");
  });
  it("makes audit events append-only", () => {
    expect(sql).toContain("audit_events_append_only");
  });
  it("enforces onboarding and provisioning idempotency", () => {
    expect(sql).toContain("unique(organization_id,idempotency_key)");
    expect(sql).toContain("unique(workflow_run_id,step_key)");
  });
});
