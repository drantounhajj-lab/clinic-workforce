/**
 * Runs the Supabase migrations on a real, local PostgreSQL with the parts of Supabase
 * they depend on (auth schema, auth.uid(), roles and default grants), so permissions
 * and server functions can be tested without touching the live project.
 */
import EmbeddedPostgres from "embedded-postgres";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const SUPABASE_SHIM = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  is_anonymous boolean not null default false,
  email_confirmed_at timestamptz,
  encrypted_password varchar(255),
  created_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create extension pgcrypto with schema extensions;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

export interface TestUser {
  id: string;
  email: string | null;
  anonymous?: boolean;
}

export class TestDb {
  private pgServer: EmbeddedPostgres;
  client: pg.Client;

  private constructor(server: EmbeddedPostgres, client: pg.Client) {
    this.pgServer = server;
    this.client = client;
  }

  static async start(port = 54000 + Math.floor(Math.random() * 1000)): Promise<TestDb> {
    const dir = join(tmpdir(), `cw-pg-${process.pid}-${port}`);
    const server = new EmbeddedPostgres({
      databaseDir: dir,
      user: "postgres",
      password: "postgres",
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    await server.initialise();
    await server.start();
    const client = new pg.Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
    await client.connect();
    await client.query(SUPABASE_SHIM);
    const dirPath = new URL("../migrations/", import.meta.url).pathname;
    for (const file of readdirSync(dirPath).filter((f) => f.endsWith(".sql")).sort()) {
      await client.query(readFileSync(join(dirPath, file), "utf8"));
    }
    return new TestDb(server, client);
  }

  async stop() {
    await this.client.end();
    await this.pgServer.stop();
  }

  /**
   * Create a login, as Supabase Auth would when someone signs in for the first time.
   * By default the email is confirmed (the person typed the code) and there is no password.
   */
  async createUser(email: string | null, anonymous = false, opts: { confirmed?: boolean; password?: boolean } = {}): Promise<TestUser> {
    const confirmed = !anonymous && email !== null && opts.confirmed !== false;
    const { rows } = await this.client.query(
      "insert into auth.users (email, is_anonymous, email_confirmed_at, encrypted_password) values ($1, $2, $3, $4) returning id",
      [email, anonymous, confirmed ? new Date() : null, opts.password ? "$2a$10$abcdefghijklmnopqrstuv" : ""],
    );
    return { id: rows[0].id, email, anonymous };
  }

  /** Run a query as a signed-in user, with row-level security applied. */
  async as<T = Record<string, unknown>>(user: TestUser | "anon", sql: string, params: unknown[] = []): Promise<T[]> {
    await this.client.query("begin");
    try {
      if (user === "anon") {
        await this.client.query("set local role anon");
      } else {
        await this.client.query("set local role authenticated");
        const claims = JSON.stringify({ sub: user.id, email: user.email, role: "authenticated", is_anonymous: !!user.anonymous });
        await this.client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
      }
      const { rows } = await this.client.query(sql, params);
      await this.client.query("commit");
      return rows as T[];
    } catch (e) {
      await this.client.query("rollback");
      throw e;
    }
  }

  /** Call one of the public functions and return its JSON result. */
  async rpc<T = Record<string, unknown>>(user: TestUser | "anon", fn: string, args: unknown[] = []): Promise<T> {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
    const rows = await this.as<{ result: T }>(user, `select public.${fn}(${placeholders}) as result`, args);
    return rows[0].result;
  }

  /** Run as the database owner (bypasses row-level security), e.g. to move the clock in tests. */
  async admin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { rows } = await this.client.query(sql, params);
    return rows as T[];
  }
}
