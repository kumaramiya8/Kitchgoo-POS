import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { getSessionFromRequest, getAdminClient } from "@/lib/server-auth";
import { supabase as anonSupabase } from "@/lib/supabase";

/**
 * Returns a Supabase client suitable for serverless route handlers.
 * Prefers the service role admin client to bypass RLS in trusted serverless routes,
 * falling back to the anon client if service role is not configured.
 */
export function getServerSupabase(): SupabaseClient {
  return getAdminClient() ?? anonSupabase;
}

/**
 * Extracts and verifies the user session, returning 401 response if unauthenticated.
 */
export function requireAuth(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) {
    return {
      session: null,
      errorResponse: NextResponse.json({ message: "Unauthorized" }, { status: 401 }),
    };
  }
  return { session, errorResponse: null };
}
