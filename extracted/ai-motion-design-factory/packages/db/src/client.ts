/**
 * DB client factory. Every caller passes `env.DATABASE_URL` directly — a
 * self-hosted Postgres (docker-compose.yml), no Cloudflare Hyperdrive in
 * front of it (Hyperdrive has no free tier — see
 * docs/06-oss-free-stack.md). The tradeoff: each Worker invocation opens
 * its own connection rather than reusing a pooled one, which is the right
 * default for a free/self-hosted deployment and only becomes a real
 * bottleneck at higher request volume, at which point Hyperdrive (or
 * PgBouncer in front of Postgres) is a drop-in addition — this function's
 * signature (a plain connection string in, a Drizzle client out) doesn't
 * need to change either way.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(connectionString: string): Db {
  // max: 5 — Workers are short-lived; keep the pool small per-isolate so a
  // burst of concurrent requests doesn't exhaust Postgres's own
  // max_connections (default 100) across many isolates.
  const client = postgres(connectionString, { max: 5, fetch_types: false, prepare: false });
  return drizzle(client, { schema });
}

export * as schema from "./schema";
