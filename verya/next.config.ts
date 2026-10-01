import type { NextConfig } from "next";

const BACKEND = process.env.BACKEND_ORIGIN || "http://localhost:4000";

const nextConfig: NextConfig = {
  // The repo has a stray package-lock.json one level up; pin Turbopack's
  // workspace root to this app so it never infers the wrong one.
  turbopack: { root: __dirname },
  async rewrites() {
    // Proxy the REST API to the Fastify backend (clean frontend/backend separation;
    // no CORS friction in dev, direct NEXT_PUBLIC_API_URL in production).
    return [
      { source: "/api/:path*", destination: `${BACKEND}/api/:path*` },
      { source: "/health", destination: `${BACKEND}/health` },
    ];
  },
};

export default nextConfig;
