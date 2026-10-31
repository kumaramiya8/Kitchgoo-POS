import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let query = supabase
      .from("orders")
      .select("total_amount, status")
      .gte("created_at", today.toISOString());

    if (branchId) {
      query = query.eq("branch_id", branchId);
    }

    const { data: orders, error } = await query;
    if (error) {
      return NextResponse.json({ message: error.message }, { status: 500 });
    }

    const totalOrders = orders?.length ?? 0;
    const paidOrders = orders?.filter((o) => o.status === "PAID") ?? [];
    const paidRevenue = paidOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
    const averageTicketSize = paidOrders.length > 0 ? paidRevenue / paidOrders.length : 0;

    return NextResponse.json({
      date: today.toISOString(),
      ordersCount: totalOrders,
      paidRevenue: Math.round(paidRevenue * 100) / 100,
      averageTicketSize: Math.round(averageTicketSize * 100) / 100,
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message }, { status: 500 });
  }
}
