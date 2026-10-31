import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");
    const date = searchParams.get("date") || new Date().toISOString().slice(0, 10);
    const openingFloat = Number(searchParams.get("openingFloat") || 0);

    const fromDate = new Date(`${date}T00:00:00.000Z`).toISOString();
    const toDate = new Date(`${date}T23:59:59.999Z`).toISOString();

    const supabase = getServerSupabase();
    let query = supabase
      .from("payments")
      .select("amount")
      .eq("tenant_id", session!.tenantId)
      .eq("method", "CASH")
      .gte("created_at", fromDate)
      .lte("created_at", toDate);

    if (branchId) {
      query = query.eq("branch_id", branchId);
    }

    const { data: payments } = await query;
    const cashSales = (payments || []).reduce((acc: number, p: any) => acc + Number(p.amount || 0), 0);
    const cashExpenses = 0;
    const expectedCash = openingFloat + cashSales - cashExpenses;

    return NextResponse.json({
      businessDate: date,
      openingFloat,
      cashSales: round2(cashSales),
      cashExpenses: round2(cashExpenses),
      expectedCash: round2(expectedCash),
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
