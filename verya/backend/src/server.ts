// Verya backend entrypoint.
import "./config/env";
import { buildApp } from "./app";
import { isDbConfigured } from "./db/pool";
import { clerkConfigured } from "./middleware/auth";

const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 4000;
const HOST = process.env.HOST || "0.0.0.0";

// Last-resort resilience: a transient Neon WebSocket drop must never kill the
// API. Route-level handlers already report per-request DB errors; this keeps the
// process alive for failures that escape a request context (idle connections).
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled rejection (process kept alive):", reason);
});

async function main(): Promise<void> {
  const app = await buildApp();
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`Verya backend listening on http://localhost:${PORT}`);
    app.log.info(`Database: ${isDbConfigured() ? "Neon Postgres configured" : "NOT configured — set DATABASE_URL in backend/.env"}`);
    app.log.info(`Auth: ${clerkConfigured() ? "Clerk (derived from publishable key)" : "development mode (set CLERK keys for production)"}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      app.log.info(`${sig} received, shutting down`);
      await app.close();
      process.exit(0);
    });
  }
}

void main();
