import { NextRequest, NextResponse } from "next/server";
import { registerSchema, DEFAULT_ROLE_PERMISSIONS, type SessionUser } from "@nodedr-restaurant/types";
import { getAdminClient, signSessionJwt, setSessionCookie } from "@/lib/server-auth";

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.json();
    const parsed = registerSchema.safeParse(rawBody);

    if (!parsed.success) {
      return NextResponse.json(
        { message: parsed.error.issues[0]?.message ?? "Invalid registration data" },
        { status: 400 },
      );
    }

    const { restaurantName, branchName, ownerName, email, password } = parsed.data;
    const admin = getAdminClient();

    if (!admin) {
      return NextResponse.json(
        {
          message:
            "Supabase credentials not configured. Please set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your Vercel project environment variables.",
        },
        { status: 500 },
      );
    }

    // 1. Create Supabase Auth user
    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email: email.toLowerCase().trim(),
      password,
      email_confirm: true,
      user_metadata: { name: ownerName },
    });

    if (authError) {
      return NextResponse.json(
        { message: authError.message || "Failed to create user account" },
        { status: 400 },
      );
    }

    const authUserId = authData.user?.id;
    if (!authUserId) {
      return NextResponse.json(
        { message: "Authentication provider returned empty user ID" },
        { status: 500 },
      );
    }

    // 2. Create Tenant (Restaurant)
    const { data: tenant, error: tenantErr } = await admin
      .from("tenants")
      .insert({
        name: restaurantName,
        currency: "INR",
        timezone: "Asia/Kolkata",
      })
      .select("id")
      .single();

    if (tenantErr || !tenant) {
      // Rollback auth user if tenant creation failed
      await admin.auth.admin.deleteUser(authUserId);
      return NextResponse.json(
        { message: tenantErr?.message || "Failed to initialize restaurant database" },
        { status: 500 },
      );
    }

    const tenantId = tenant.id;

    // 3. Update Supabase Auth user's app_metadata with tenant_id for RLS
    await admin.auth.admin.updateUserById(authUserId, {
      app_metadata: {
        tenant_id: tenantId,
        role: "OWNER",
      },
    });

    // 4. Create Default Branch
    const { data: branch } = await admin
      .from("branches")
      .insert({
        tenant_id: tenantId,
        name: branchName || "Main Branch",
      })
      .select("id")
      .single();

    const branchId = branch?.id ?? null;

    // 5. Create User profile record
    await admin.from("users").insert({
      id: authUserId,
      tenant_id: tenantId,
      branch_id: branchId,
      name: ownerName,
      email: email.toLowerCase().trim(),
      role: "OWNER",
      is_active: true,
    });

    if (branchId) {
      // 6. Create Default Floor & Tables
      const { data: floor } = await admin
        .from("floors")
        .insert({
          tenant_id: tenantId,
          branch_id: branchId,
          name: "Main Dining",
          sort_order: 0,
        })
        .select("id")
        .single();

      if (floor?.id) {
        const tables = [1, 2, 3, 4, 5, 6].map((num) => ({
          tenant_id: tenantId,
          branch_id: branchId,
          floor_id: floor.id,
          number: String(num),
          name: `Table ${num}`,
          capacity: num <= 2 ? 2 : 4,
          status: "AVAILABLE",
        }));
        await admin.from("tables").insert(tables);
      }

      // 7. Starter Categories
      const categories = ["Beverages", "Starters", "Main Course", "Desserts"].map(
        (name, i) => ({
          tenant_id: tenantId,
          branch_id: branchId,
          name,
          sort_order: i,
          is_active: true,
        }),
      );
      await admin.from("menu_categories").insert(categories);
    }

    const sessionUser: SessionUser = {
      id: authUserId,
      restaurantId: tenantId,
      name: ownerName,
      roleId: "OWNER",
      roleName: "OWNER",
      permissions: Array.from(DEFAULT_ROLE_PERMISSIONS.OWNER),
    };

    const token = signSessionJwt(sessionUser);
    const res = NextResponse.json({ user: sessionUser, token });
    setSessionCookie(res, token);
    return res;
  } catch (err: any) {
    console.error("Register error:", err);
    return NextResponse.json(
      { message: err?.message || "Internal server error" },
      { status: 500 },
    );
  }
}
