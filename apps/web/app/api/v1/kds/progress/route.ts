import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");
    if (!branchId) {
      return NextResponse.json([]);
    }

    const supabase = getServerSupabase();
    const { data: tickets, error } = await supabase
      .from("kots")
      .select("id, order_id, status, created_at, orders(id, order_number, type, table_id, tables(id, number, name))")
      .eq("tenant_id", session!.tenantId)
      .eq("branch_id", branchId)
      .in("status", ["NEW", "ACCEPTED", "PREPARING", "READY"])
      .order("created_at", { ascending: true });

    if (error) {
      // Egress & fault-tolerance: Return empty list rather than hard error so POS never breaks
      return NextResponse.json([]);
    }

    const result = (tickets || []).map((t: any) => ({
      id: t.id,
      orderId: t.order_id,
      status: t.status,
      createdAt: t.created_at,
      readyAt: null,
      order: {
        orderNumber: t.orders?.order_number || "",
        type: t.orders?.type || "DINE_IN",
        table: t.orders?.tables
          ? {
              id: t.orders.tables.id,
              number: String(t.orders.tables.number),
              name: t.orders.tables.name,
            }
          : null,
      },
    }));

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json([]);
  }
}
