import type { NextConfig } from "next";

// In local Docker mode with a separate NestJS backend container, requests to
// /api/* can optionally be proxied to BACKEND_URL.
// On Vercel Serverless SaaS, requests are handled natively by App Router
// route handlers in app/api/ and backed directly by Supabase.
const BACKEND_URL = process.env.BACKEND_URL;

const nextConfig: NextConfig = {
  skipTrailingSlashRedirect: true,
  async rewrites() {
    if (!BACKEND_URL) {
      return [];
    }
    return [
      { source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` },
      { source: "/socket.io/", destination: `${BACKEND_URL}/socket.io/` },
      { source: "/socket.io/:path+", destination: `${BACKEND_URL}/socket.io/:path+` },
    ];
  },
};

export default nextConfig;
