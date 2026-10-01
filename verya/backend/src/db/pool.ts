// Verya — Postgres pool. The single database access point for all repositories.
//
// TRANSPORT (important): the default transport is Neon's serverless driver, which
// tunnels the Postgres wire protocol over WebSocket to port **443**. This machine's
// network intermittently blocks outbound TCP **5432** (plain `pg` connections then
// hang and every DB-backed route times out), while 443 is reliably open. The driver
// talks to the same Neon pooler with the same connection string, and supports the
// same Pool.query / Pool.connect transaction surface we use.
//
// Set VERYA_PG_FORCE_TCP=1 to use the classic raw-TCP `pg` transport instead — for
// environments where :5432 is guaranteed reachable (e.g. CI with direct egress).
import { Pool as PgPool, type Pool as PgPoolType } from "pg";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import "../config/env";

const databaseUrl = process.env.DATABASE_URL || process.env.neon_db;
const forceTcp = process.env.VERYA_PG_FORCE_TCP === "1";

if (!databaseUrl) {
  console.warn(
    "[db] DATABASE_URL is not set. The API will start but every database-backed " +
      "route will fail with a clear error until Neon Postgres is configured."
  );
}

if (!forceTcp) {
  // Tunnel through 443: Neon's WebSocket proxy endpoint on the standard HTTPS port.
  neonConfig.wsProxy = (host) => `${host}:443/v2`;
  neonConfig.useSecureWebSocket = true;
}

export const pool: PgPool = forceTcp
  ? new PgPool({
      connectionString: databaseUrl,
      max: Number(process.env.PG_POOL_MAX || 10),
      ssl: process.env.PGSSL_DISABLE === "1" ? undefined : { rejectUnauthorized: false },
    })
  : // Wire/API-compatible with pg's Pool for the surface this app uses
    // (query, connect/transaction clients with .query/.release, end).
    (new NeonPool({
      connectionString: databaseUrl,
      max: Number(process.env.PG_POOL_MAX || 10),
      connectionTimeoutMillis: 15000,
    }) as unknown as PgPoolType);

// A dropped WebSocket (idle Neon connection closed by the network/CDN) surfaces as
// an "error" event on the pool. Without a listener, Node turns it into an
// uncaught exception and KILLS the whole API process. Log and keep serving —
// the next query opens a fresh connection; in-flight queries get their own error.
pool.on("error", (err: Error) => {
  console.warn("[db] idle pool client error (connection will be re-established):", err.message);
});

export async function query<T = unknown>(text: string, params?: unknown[]): Promise<T[]> {
  const res = await pool.query(text, params as never[]);
  return res.rows as T[];
}

/** Throws a clean error when the database is not configured. */
export function requireDb(): void {
  if (!databaseUrl) {
    const err = new Error(
      "DATABASE_URL is not configured. Add your Neon connection string to backend/.env and restart."
    );
    err.name = "DbNotConfigured";
    throw err;
  }
}

export function isDbConfigured(): boolean {
  return Boolean(databaseUrl);
}
