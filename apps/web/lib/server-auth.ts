import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { DEFAULT_ROLE_PERMISSIONS, type SessionUser } from "@nodedr-restaurant/types";

export const SESSION_COOKIE = "nodedr_session";

export function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function getJwtSecret(): string {
  return process.env.JWT_SECRET || "kitchgoo-pos-default-jwt-secret-at-least-32-chars";
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(str: string): string {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString("utf-8");
}

export function signSessionJwt(
  user: SessionUser,
  expiresInSeconds = 7 * 24 * 60 * 60,
): string {
  const secret = getJwtSecret();
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.id,
    aud: "authenticated",
    role: "authenticated",
    app_metadata: {
      tenant_id: user.restaurantId,
      role: user.roleName,
    },
    user_metadata: {
      name: user.name,
    },
    session_user: user,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function verifySessionJwt(token: string): { user: SessionUser; tenantId: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const secret = getJwtSecret();

    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    if (sigB64 !== expectedSig) return null;

    const payload = JSON.parse(base64UrlDecode(payloadB64));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    if (payload.session_user) {
      return {
        user: payload.session_user,
        tenantId: payload.app_metadata?.tenant_id || payload.session_user.restaurantId,
      };
    }

    if (payload.sub && payload.app_metadata?.tenant_id) {
      const roleName = (payload.app_metadata?.role as keyof typeof DEFAULT_ROLE_PERMISSIONS) || "OWNER";
      const permissions = DEFAULT_ROLE_PERMISSIONS[roleName] || DEFAULT_ROLE_PERMISSIONS.OWNER;
      return {
        user: {
          id: payload.sub,
          restaurantId: payload.app_metadata.tenant_id,
          name: payload.user_metadata?.name || "Staff",
          roleId: roleName,
          roleName: roleName,
          permissions: Array.from(permissions),
        },
        tenantId: payload.app_metadata.tenant_id,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function getSessionFromRequest(req: NextRequest): { user: SessionUser; tenantId: string } | null {
  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  if (cookie) {
    const session = verifySessionJwt(cookie);
    if (session) return session;
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    return verifySessionJwt(token);
  }

  return null;
}

export function setSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
}
