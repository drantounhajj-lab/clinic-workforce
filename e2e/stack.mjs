/**
 * Local copy of the backend for end-to-end tests: PostgreSQL with the real migrations,
 * PostgREST (same API as Supabase), and a small stand-in for Supabase Auth.
 *
 *   node e2e/stack.mjs          → http://localhost:54321 (use it as the Supabase URL)
 *
 * Email codes: any email, code 123456. Test helpers: POST /__test/sql, POST /__test/session.
 * Nothing here talks to the live project.
 */
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const ROOT = new URL("..", import.meta.url).pathname;
const PG_PORT = 54330;
const REST_PORT = 54331;
const GATEWAY_PORT = Number(process.env.PORT ?? 54321);
const SECRET = "local-e2e-jwt-secret-at-least-32-characters-long";
const CODE = "123456";

const shim = readFileSync(join(ROOT, "supabase/tests/harness.ts"), "utf8").match(/const SUPABASE_SHIM = `([\s\S]*?)`;/)[1];

const server = new EmbeddedPostgres({
  databaseDir: join(tmpdir(), `cw-e2e-${Date.now()}`),
  user: "postgres",
  password: "postgres",
  port: PG_PORT,
  persistent: false,
  initdbFlags: ["--encoding=UTF8", "--locale=C"], // accents, as on Supabase
  onLog: () => {},
  onError: () => {},
});
await server.initialise();
await server.start();
const db = new pg.Client({ host: "localhost", port: PG_PORT, user: "postgres", password: "postgres", database: "postgres" });
await db.connect();
await db.query(shim);
for (const f of readdirSync(join(ROOT, "supabase/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
  await db.query(readFileSync(join(ROOT, "supabase/migrations", f), "utf8"));
}
await db.query(`
  create role authenticator login password 'authpass' noinherit;
  grant anon, authenticated, service_role to authenticator;
  -- record what would be pushed (no network)
  create schema if not exists net;
  create table if not exists net.calls (id bigserial primary key, url text, body jsonb, at timestamptz default now());
  create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
    headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint
  language sql security definer as $f$ insert into net.calls (url, body) values (url, body) returning id $f$;
`);

const rest = spawn(join(ROOT, "e2e/.bin/postgrest"), [], {
  env: {
    PGRST_DB_URI: `postgres://authenticator:authpass@localhost:${PG_PORT}/postgres`,
    PGRST_DB_SCHEMAS: "public",
    PGRST_DB_ANON_ROLE: "anon",
    PGRST_JWT_SECRET: SECRET,
    PGRST_SERVER_PORT: String(REST_PORT),
    PGRST_LOG_LEVEL: "warn",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

// ---------------------------------------------------------------- Auth stand-in

const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function sign(payload) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const refresh = new Map(); // refresh token -> { userId, method }

async function userRow(id) {
  const { rows } = await db.query("select id, email, is_anonymous, email_confirmed_at, created_at from auth.users where id = $1", [id]);
  return rows[0];
}
function userJson(u) {
  return {
    id: u.id,
    aud: "authenticated",
    role: "authenticated",
    email: u.email ?? "",
    email_confirmed_at: u.email_confirmed_at,
    confirmed_at: u.email_confirmed_at,
    phone: "",
    app_metadata: { provider: u.is_anonymous ? "anonymous" : "email", providers: u.is_anonymous ? [] : ["email"] },
    user_metadata: {},
    identities: [],
    created_at: u.created_at,
    updated_at: u.created_at,
    is_anonymous: u.is_anonymous,
  };
}
async function session(userId, method) {
  const u = await userRow(userId);
  const now = Math.floor(Date.now() / 1000);
  const access = sign({
    sub: u.id,
    email: u.email,
    role: "authenticated",
    aud: "authenticated",
    iat: now,
    exp: now + 3600,
    is_anonymous: u.is_anonymous,
    amr: [{ method, timestamp: now }],
    session_id: randomUUID(),
  });
  const rt = randomUUID();
  refresh.set(rt, { userId, method });
  return { access_token: access, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: rt, user: userJson(u) };
}
async function userForEmail(email, confirm) {
  const e = email.trim().toLowerCase();
  let { rows } = await db.query("select id from auth.users where lower(email) = $1", [e]);
  if (!rows.length) {
    ({ rows } = await db.query("insert into auth.users (email, encrypted_password) values ($1, 'random-hidden') returning id", [e]));
  }
  if (confirm) await db.query("update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1", [rows[0].id]);
  return rows[0].id;
}
function claimsOf(req) {
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  return JSON.parse(Buffer.from(parts[1], "base64url").toString());
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, prefer, accept-profile, content-profile, range, range-unit, x-supabase-api-version, accept",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS, HEAD",
  "access-control-expose-headers": "content-range, content-location, location, x-total-count",
};
const send = (res, status, body) => {
  res.writeHead(status, { ...CORS, "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

async function auth(req, res, path, query, raw) {
  const body = raw.length ? JSON.parse(raw.toString()) : {};
  if (path === "/otp") {
    await userForEmail(body.email, false);
    return send(res, 200, {});
  }
  if (path === "/verify") {
    if (body.token !== CODE) return send(res, 403, { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" });
    return send(res, 200, await session(await userForEmail(body.email, true), "otp"));
  }
  if (path === "/signup" && !body.email) {
    const { rows } = await db.query("insert into auth.users (is_anonymous) values (true) returning id");
    return send(res, 200, await session(rows[0].id, "anonymous"));
  }
  if (path === "/token" && query.get("grant_type") === "refresh_token") {
    const r = refresh.get(body.refresh_token);
    if (!r) return send(res, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
    return send(res, 200, await session(r.userId, r.method));
  }
  if (path === "/token" && query.get("grant_type") === "password") {
    const { rows } = await db.query("select id from auth.users where lower(email) = lower($1) and encrypted_password = $2", [body.email, `pw:${body.password}`]);
    if (!rows.length) return send(res, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
    return send(res, 200, await session(rows[0].id, "password"));
  }
  if (path === "/user") {
    const c = claimsOf(req);
    if (!c) return send(res, 401, { code: 401, msg: "no token" });
    return send(res, 200, userJson(await userRow(c.sub)));
  }
  if (path === "/logout") return send(res, 204);
  return send(res, 404, { msg: `not mocked: ${req.method} ${path}` });
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "OPTIONS") return send(res, 204);
      const raw = await readBody(req);
      if (url.pathname.startsWith("/auth/v1")) return await auth(req, res, url.pathname.slice(8), url.searchParams, raw);
      if (url.pathname === "/__test/sql") {
        const { sql, params } = JSON.parse(raw.toString());
        const { rows } = await db.query(sql, params ?? []);
        return send(res, 200, rows);
      }
      if (url.pathname === "/__test/session") {
        const { email, password } = JSON.parse(raw.toString());
        if (password) {
          const { rows } = await db.query("insert into auth.users (email, encrypted_password, email_confirmed_at) values (lower($1), $2, now()) returning id", [email, `pw:${password}`]);
          return send(res, 200, { id: rows[0].id });
        }
        return send(res, 200, await session(await userForEmail(email, true), "otp"));
      }
      if (url.pathname.startsWith("/rest/v1")) {
        const headers = { ...req.headers, host: `localhost:${REST_PORT}` };
        if (!claimsOf(req)) delete headers.authorization; // publishable key isn't a JWT: anonymous
        delete headers["content-length"];
        if (raw.length) headers["content-length"] = String(raw.length);
        const up = http.request({ host: "localhost", port: REST_PORT, path: url.pathname.slice(8) + url.search, method: req.method, headers }, (r) => {
          res.writeHead(r.statusCode ?? 502, { ...r.headers, ...CORS });
          r.pipe(res);
        });
        up.on("error", (e) => send(res, 502, { msg: e.message }));
        up.end(raw);
        return;
      }
      send(res, 404, { msg: "not found" });
    } catch (e) {
      send(res, 500, { msg: e.message });
    }
  })
  .listen(GATEWAY_PORT, () => {
    // Wait for PostgREST to be ready
    const ping = () =>
      http
        .get(`http://localhost:${REST_PORT}/`, () => console.log(`READY http://localhost:${GATEWAY_PORT}`))
        .on("error", () => setTimeout(ping, 300));
    ping();
  });

const stop = async () => {
  rest.kill();
  await db.end().catch(() => {});
  await server.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
