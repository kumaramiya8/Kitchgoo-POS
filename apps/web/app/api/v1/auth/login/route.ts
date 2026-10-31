import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { loginSchema, DEFAULT_ROLE_PERMISSIONS, type SessionUser } from "@nodedr-restaurant/types";
import { getAdminClient, signSessionJwt, setSessionCookie } from "@/lib/server-auth";

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.json();
    const parsed = loginSchema.safeParse(rawBody);

    if (!parsed.success) {
      return NextResponse.json(
        { message: parsed.error.issues[0]?.message ?? "Invalid login credentials" },
        { status: 400 },
      );
    }

    const { email, password } = parsed.data;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !anonKey) {
      return NextResponse.json(
        { message: "Supabase authentication is not configured" },
        { status: 500 },
      );
    }

    // Authenticate with Supabase Auth
    const client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: authData, error: authErr } = await client.auth.signInWithPassword({
      email: email.toLowerCase().trim(),
      password,
    });

    if (authErr || !authData.user) {
      return NextResponse.json(
        { message: "Invalid email or password" },
        { status: 401 },
      );
    }

    const authUserId = authData.user.id;
    const admin = getAdminClient();
    const queryClient = admin ?? client;

    // Fetch user details & role
    const { data: userProfile } = await queryClient
      .from("users")
      .select("id, tenant_id, branch_id, name, email, role, is_active")
      .eq("id", authUserId)
      .single();

    const tenantId =
      userProfile?.tenant_id ||
      authData.user.app_metadata?.tenant_id ||
      "";

    const roleName =
      (userProfile?.role as keyof typeof DEFAULT_ROLE_PERMISSIONS) ||
      (authData.user.app_metadata?.role as keyof typeof DEFAULT_ROLE_PERMISSIONS) ||
      "OWNER";

    const permissions = DEFAULT_ROLE_PERMISSIONS[roleName] || DEFAULT_ROLE_PERMISSIONS.CASHIER;

    const sessionUser: SessionUser = {
      id: authUserId,
      restaurantId: tenantId,
      name: userProfile?.name || authData.user.user_metadata?.name || "Staff",
      roleId: roleName,
      roleName: roleName,
      permissions: Array.from(permissions),
    };

    const token = signSessionJwt(sessionUser);
    const res = NextResponse.json({ user: sessionUser, token });
    setSessionCookie(res, token);
    return res;
  } catch (err: any) {
    console.error("Login error:", err);
    return NextResponse.json(
      { message: err?.message || "Internal server error" },
      { status: 500 },
    );
  }
}
