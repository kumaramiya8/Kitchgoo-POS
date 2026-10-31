import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const from = searchParams.get("from") || new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const to = searchParams.get("to") || new Date().toISOString().slice(0, 10);

    const fromDate = new Date(`${from}T00:00:00.000Z`).toISOString();
    const toDate = new Date(`${to}T23:59:59.999Z`).toISOString();

    const supabase = getServerSupabase();

    const { data: branches } = await supabase
      .from("branches")
      .select("id, name")
      .eq("tenant_id", session!.tenantId)
      .eq("is_active", true);

    const result = [];
    for (const b of branches || []) {
      const { data: orders } = await supabase
        .from("orders")
        .select("total_amount, status")
        .eq("tenant_id", session!.tenantId)
        .eq("branch_id", b.id)
        .gte("created_at", fromDate)
        .lte("created_at", toDate);

      const paid = (orders || []).filter((o: any) => o.status === "PAID");
      const open = (orders || []).filter((o: any) => o.status === "OPEN" || o.status === "BILLED");
      const sales = paid.reduce((s: number, o: any) => s + Number(o.total_amount || 0), 0);

      result.push({
        branchId: b.id,
        name: b.name,
        orders: paid.length,
        sales: round2(sales),
        openOrders: open.length,
        lowStockItems: 0,
        inventoryValue: 0,
      });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
