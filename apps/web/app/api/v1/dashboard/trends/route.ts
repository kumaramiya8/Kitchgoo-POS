import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest, getAdminClient } from "@/lib/server-auth";
import { supabase } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");

    const admin = getAdminClient();
    const client = admin ?? supabase;

    // Past 7 days revenue trends
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let query = client
      .from("orders")
      .select("total_amount, created_at")
      .eq("tenant_id", session.tenantId)
      .eq("status", "PAID")
      .gte("created_at", sevenDaysAgo);

    if (branchId) {
      query = query.eq("branch_id", branchId);
    }

    const { data } = await query;
    const dailyMap = new Map<string, number>();

    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      dailyMap.set(d, 0);
    }

    (data || []).forEach((row: any) => {
      const dateKey = row.created_at?.slice(0, 10);
      if (dateKey && dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, (dailyMap.get(dateKey) || 0) + Number(row.total_amount || 0));
      }
    });

    const revenue = Array.from(dailyMap.entries()).map(([date, amount]) => ({
      date,
      amount,
    }));

    return NextResponse.json({
      revenue,
      waste: [],
    });
  } catch (err: any) {
    return NextResponse.json(
      { message: err?.message || "Internal server error" },
      { status: 500 },
    );
  }
}
