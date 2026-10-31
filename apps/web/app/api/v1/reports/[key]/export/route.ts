import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";
import { ensureSeeded } from "@/lib/seed-service";

export const maxDuration = 60;

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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { key } = await params;
    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");
    const from = searchParams.get("from") || new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const to = searchParams.get("to") || new Date().toISOString().slice(0, 10);

    const fromDate = new Date(`${from}T00:00:00.000Z`).toISOString();
    const toDate = new Date(`${to}T23:59:59.999Z`).toISOString();

    const supabase = getServerSupabase();

    const orders = await fetchAllRows<any>((rangeFrom, rangeTo) => {
      let q = supabase
        .from("orders")
        .select("order_number, guest_name, total_amount, tax_amount, subtotal, status, created_at")
        .eq("tenant_id", session!.tenantId)
        .eq("status", "PAID")
        .gte("created_at", fromDate)
        .lte("created_at", toDate)
        .order("created_at", { ascending: false })
        .range(rangeFrom, rangeTo);
      if (branchId) q = q.eq("branch_id", branchId);
      return q;
    });

    const csvLines = ["Invoice Number,Date,Guest Name,Net Sales (₹),Tax (₹),Total (₹)"];
    for (const o of orders) {
      const inv = o.order_number;
      const d = (o.created_at || "").slice(0, 19).replace("T", " ");
      const g = (o.guest_name || "Walk-in Guest").replace(/,/g, " ");
      const sub = Number(o.subtotal || 0).toFixed(2);
      const tax = Number(o.tax_amount || 0).toFixed(2);
      const tot = Number(o.total_amount || 0).toFixed(2);
      csvLines.push(`${inv},${d},${g},${sub},${tax},${tot}`);
    }

    const csvContent = csvLines.join("\n");

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${key}-${from}-to-${to}.csv"`,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
