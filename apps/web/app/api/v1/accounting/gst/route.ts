import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";
import { ensureSeeded } from "@/lib/seed-service";

export const maxDuration = 60;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

async function fetchAllRows<T>(queryBuilder: (rangeFrom: number, rangeTo: number) => any): Promise<T[]> {
  const all: T[] = [];
  const pageSize = 1000;
  let page = 0;
  while (true) {
    const from = page * pageSize;
    const to = (page + 1) * pageSize - 1;
    const { data, error } = await queryBuilder(from, to);
    if (error || !data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    page++;
    if (page > 10) break;
  }
  return all;
}

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");
    const from = searchParams.get("from") || new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const to = searchParams.get("to") || new Date().toISOString().slice(0, 10);

    const fromDate = new Date(`${from}T00:00:00.000Z`).toISOString();
    const toDate = new Date(`${to}T23:59:59.999Z`).toISOString();

    const supabase = getServerSupabase();

    // Auto-seed if 0 orders exist
    const { count: orderCount } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", session!.tenantId);

    if (!orderCount || orderCount === 0) {
      await ensureSeeded(supabase, session!.tenantId, branchId);
    }

    const orders = await fetchAllRows<any>((rangeFrom, rangeTo) => {
      let q = supabase
        .from("orders")
        .select("id, total_amount, tax_amount, subtotal")
        .eq("tenant_id", session!.tenantId)
        .eq("status", "PAID")
        .gte("created_at", fromDate)
        .lte("created_at", toDate)
        .range(rangeFrom, rangeTo);
      if (branchId) q = q.eq("branch_id", branchId);
      return q;
    });

    let totalTaxable = 0;
    let totalTax = 0;
    let count = 0;

    for (const o of orders) {
      count++;
      const sub = Number(o.subtotal || 0);
      const tax = Number(o.tax_amount || 0);
      totalTaxable += sub;
      totalTax += tax;
    }

    const rateMap: Record<number, { taxableValue: number; tax: number; total: number }> = {
      5: {
        taxableValue: round2(totalTaxable),
        tax: round2(totalTax),
        total: round2(totalTaxable + totalTax),
      },
    };

    const rows = Object.entries(rateMap).map(([rate, v]) => ({
      ratePercent: Number(rate),
      taxableValue: v.taxableValue,
      tax: v.tax,
      total: v.total,
    }));

    return NextResponse.json({
      orders: count,
      rows,
      totalTaxable: round2(totalTaxable),
      totalTax: round2(totalTax),
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
