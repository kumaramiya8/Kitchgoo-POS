import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";
import { ensureSeeded } from "@/lib/seed-service";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");
    const tab = searchParams.get("tab") || "active";
    const channel = searchParams.get("channel");
    const type = searchParams.get("type");
    const search = searchParams.get("search");
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.min(Math.max(1, Number(limitParam)), 2500) : 250;

    const supabase = getServerSupabase();

    if (tab === "history") {
      const { count: orderCount } = await supabase
        .from("orders")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", session!.tenantId);

      if (!orderCount || orderCount === 0) {
        await ensureSeeded(supabase, session!.tenantId, branchId);
      }
    }

    let query = supabase
      .from("orders")
      .select(`
        id, order_number, type, status, channel, acceptance,
        guest_name, total_amount, created_at,
        tables(id, number, name),
        customers(id, name, phone),
        order_items(id, name_snapshot, quantity)
      `)
      .eq("tenant_id", session!.tenantId)
      .order("created_at", { ascending: false });

    if (branchId) {
      query = query.eq("branch_id", branchId);
    }

    if (channel) {
      query = query.eq("channel", channel);
    }

    if (type) {
      query = query.eq("type", type);
    }

    if (search && search.trim()) {
      const s = search.trim();
      query = query.or(`order_number.ilike.%${s}%,guest_name.ilike.%${s}%`);
    }

    if (tab === "pending") {
      query = query.eq("acceptance", "PENDING").limit(limit);
    } else if (tab === "active") {
      query = query.in("status", ["OPEN", "BILLED"]).limit(limit);
    } else if (tab === "history") {
      query = query.in("status", ["PAID", "CANCELLED", "REFUNDED"]).limit(limit);
    }

    const { data: orders, error } = await query;
    if (error) {
      return NextResponse.json({ message: error.message }, { status: 500 });
    }

    const result = (orders || []).map((o: any) => ({
      id: o.id,
      orderNumber: o.order_number,
      type: o.type,
      status: o.status,
      channel: o.channel || "STAFF",
      acceptance: o.acceptance || "NOT_REQUIRED",
      guestName: o.guest_name,
      totalAmount: String(o.total_amount || 0),
      createdAt: o.created_at,
      table: o.tables
        ? {
            id: o.tables.id,
            name: o.tables.name,
            number: Number(o.tables.number) || 0,
          }
        : null,
      customer: o.customers
        ? {
            id: o.customers.id,
            name: o.customers.name,
            phone: o.customers.phone,
          }
        : null,
      items: (o.order_items || []).map((i: any) => ({
        id: i.id,
        nameSnapshot: i.name_snapshot,
        quantity: i.quantity,
      })),
    }));

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
