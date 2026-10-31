import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function POST(req: NextRequest) {
  try {
    const admin = getAdminClient();
    if (!admin) {
      return NextResponse.json(
        { message: "Server configuration missing service role key" },
        { status: 500 },
      );
    }

    const body = await req.json();
    const { tenantId, name, email, role, pin, branchId } = body;

    if (!tenantId || !name || !role) {
      return NextResponse.json(
        { message: "tenantId, name, and role are required" },
        { status: 400 },
      );
    }

    let authUserId: string | null = null;
    if (email) {
      const { data, error } = await admin.auth.admin.createUser({
        email: email.toLowerCase().trim(),
        email_confirm: true,
        user_metadata: { name },
        app_metadata: { tenant_id: tenantId, role },
      });
      if (error) {
        return NextResponse.json({ message: error.message }, { status: 400 });
      }
      authUserId = data.user?.id ?? null;
    }

    // Insert staff user record in database
    const { data: user, error: userError } = await admin
      .from("users")
      .insert({
        ...(authUserId ? { id: authUserId } : {}),
        tenant_id: tenantId,
        branch_id: branchId ?? null,
        name,
        email: email ?? null,
        role,
        pin_hash: pin ?? null,
      })
      .select("id, name, role")
      .single();

    if (userError) {
      return NextResponse.json({ message: userError.message }, { status: 500 });
    }

    return NextResponse.json(user);
  } catch (err: any) {
    return NextResponse.json(
      { message: err?.message ?? "Internal server error" },
      { status: 500 },
    );
  }
}
