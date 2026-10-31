import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search");

    const supabase = getServerSupabase();
    let query = supabase
      .from("customers")
      .select("id, name, phone, email, address, notes, loyalty_points, wallet_balance, created_at")
      .eq("tenant_id", session!.tenantId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (search) {
      query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
    }

    const { data: customers } = await query;
    const result = (customers || []).map((c: any) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      address: c.address,
      birthday: null,
      anniversary: null,
      allergies: null,
      notes: c.notes,
      loyaltyPoints: c.loyalty_points || 0,
      walletBalance: String(c.wallet_balance || 0),
      createdAt: c.created_at,
    }));

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json([]);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");

    const body = await req.json();
    const { name, phone, email, address, notes } = body;

    const supabase = getServerSupabase();
    const { data: created, error } = await supabase
      .from("customers")
      .insert({
        tenant_id: session!.tenantId,
        branch_id: branchId || null,
        name: name?.trim() || "Guest",
        phone: phone || null,
        email: email || null,
        address: address || null,
        notes: notes || null,
      })
      .select("id, name, phone, email, address, notes, loyalty_points, wallet_balance, created_at")
      .single();

    if (error || !created) {
      return NextResponse.json({ message: error?.message || "Failed to create customer" }, { status: 500 });
    }

    return NextResponse.json({
      id: created.id,
      name: created.name,
      phone: created.phone,
      email: created.email,
      address: created.address,
      birthday: null,
      anniversary: null,
      allergies: null,
      notes: created.notes,
      loyaltyPoints: created.loyalty_points || 0,
      walletBalance: String(created.wallet_balance || 0),
      createdAt: created.created_at,
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
