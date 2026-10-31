import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

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
    const body = await req.json();
    const { restaurantName, ownerName, email, password, branchName } = body;

    if (!restaurantName || !email) {
      return NextResponse.json(
        { message: "Restaurant name and email are required" },
        { status: 400 },
      );
    }

    const admin = getAdminClient();
    let authUserId: string | null = null;

    // 1. Create Auth user if admin client is available
    if (admin && password) {
      const { data: authData, error: authError } = await admin.auth.admin.createUser({
        email: email.toLowerCase().trim(),
        password,
        email_confirm: true,
        user_metadata: { name: ownerName },
      });

      if (authError) {
        return NextResponse.json({ message: authError.message }, { status: 400 });
      }
      authUserId = authData.user?.id ?? null;
    }

    // 2. Insert Tenant record
    const client = admin ?? supabase;
    const { data: tenant, error: tenantErr } = await client
      .from("tenants")
      .insert({
        name: restaurantName,
        currency: body.currency ?? "INR",
        timezone: body.timezone ?? "Asia/Kolkata",
      })
      .select("id")
      .single();

    if (tenantErr || !tenant) {
      return NextResponse.json(
        { message: tenantErr?.message ?? "Failed to create tenant" },
        { status: 500 },
      );
    }

    const tenantId = tenant.id;

    // 3. Update Auth user app_metadata with tenant_id for RLS
    if (admin && authUserId) {
      await admin.auth.admin.updateUserById(authUserId, {
        app_metadata: {
          tenant_id: tenantId,
          role: "OWNER",
        },
      });
    }

    // 4. Create Default Branch
    const { data: branch } = await client
      .from("branches")
      .insert({
        tenant_id: tenantId,
        name: branchName ?? "Main Branch",
      })
      .select("id")
      .single();

    const branchId = branch?.id;

    if (branchId) {
      // 5. Create Default Floor & Tables
      const { data: floor } = await client
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
        await client.from("tables").insert(tables);
      }

      // 6. Starter Categories
      const categories = ["Beverages", "Starters", "Main Course", "Desserts"].map(
        (name, i) => ({
          tenant_id: tenantId,
          branch_id: branchId,
          name,
          sort_order: i,
          is_active: true,
        }),
      );
      await client.from("menu_categories").insert(categories);
    }

    return NextResponse.json({
      success: true,
      tenantId,
      branchId,
      userId: authUserId,
    });
  } catch (err: any) {
    return NextResponse.json(
      { message: err?.message ?? "Internal server error" },
      { status: 500 },
    );
  }
}
