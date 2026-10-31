import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";
import { ensureSeeded } from "@/lib/seed-service";
import { SEED_MENU_ITEMS } from "@/lib/seed-data";

export const maxDuration = 60;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Map seed menu item names to categories for guaranteed category matching
const seedCategoryMap = new Map<string, string>();
for (const it of SEED_MENU_ITEMS) {
  seedCategoryMap.set(it.name.toLowerCase().trim(), it.category);
}

/**
 * Paginates PostgREST queries to bypass the default 1,000-row limit.
 */
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
    if (page > 10) break; // safety ceiling (10,000 rows)
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

    // Auto-seed if restaurant has 0 orders
    const { count: orderCount } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", session!.tenantId);

    if (!orderCount || orderCount === 0) {
      await ensureSeeded(supabase, session!.tenantId, branchId);
    }

    // 1. Daily Sales Report
    if (key === "sales-daily") {
      const orders = await fetchAllRows<{
        total_amount: number;
        tax_amount: number;
        subtotal: number;
        created_at: string;
      }>((rangeFrom, rangeTo) => {
        let q = supabase
          .from("orders")
          .select("total_amount, tax_amount, subtotal, created_at")
          .eq("tenant_id", session!.tenantId)
          .eq("status", "PAID")
          .gte("created_at", fromDate)
          .lte("created_at", toDate)
          .order("created_at", { ascending: false })
          .range(rangeFrom, rangeTo);
        if (branchId) q = q.eq("branch_id", branchId);
        return q;
      });

      const dayMap = new Map<string, { count: number; gross: number; tax: number; subtotal: number }>();

      for (const o of orders) {
        const d = (o.created_at || "").slice(0, 10);
        if (!dayMap.has(d)) dayMap.set(d, { count: 0, gross: 0, tax: 0, subtotal: 0 });
        const cur = dayMap.get(d)!;
        cur.count++;
        cur.gross += Number(o.total_amount || 0);
        cur.tax += Number(o.tax_amount || 0);
        cur.subtotal += Number(o.subtotal || 0);
      }

      const rows = Array.from(dayMap.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([date, d]) => [
          date,
          d.count,
          round2(d.gross),
          round2(d.tax),
          round2(d.subtotal),
        ]);

      return NextResponse.json({
        key,
        title: "Daily sales",
        columns: ["Date", "Orders", "Gross Sales (₹)", "Tax (₹)", "Net Sales (₹)"],
        rows,
      });
    }

    // 2. Sales by Item / Popular Items / Slow Movers
    if (key === "sales-by-item" || key === "popular-items" || key === "slow-movers") {
      const items = await fetchAllRows<{
        name_snapshot: string;
        quantity: number;
        line_total: number;
      }>((rangeFrom, rangeTo) => {
        let q = supabase
          .from("order_items")
          .select("name_snapshot, quantity, line_total, orders!inner(status, created_at, branch_id)")
          .eq("tenant_id", session!.tenantId)
          .eq("orders.status", "PAID")
          .gte("orders.created_at", fromDate)
          .lte("orders.created_at", toDate)
          .range(rangeFrom, rangeTo);
        if (branchId) q = q.eq("orders.branch_id", branchId);
        return q;
      });

      const itemMap = new Map<string, { qty: number; total: number }>();

      for (const it of items) {
        const name = it.name_snapshot || "Item";
        if (!itemMap.has(name)) itemMap.set(name, { qty: 0, total: 0 });
        const cur = itemMap.get(name)!;
        cur.qty += Number(it.quantity || 1);
        cur.total += Number(it.line_total || 0);
      }

      let sorted = Array.from(itemMap.entries());
      if (key === "slow-movers") {
        sorted.sort((a, b) => a[1].total - b[1].total);
      } else {
        sorted.sort((a, b) => b[1].total - a[1].total);
      }

      const rows = sorted.map(([name, d]) => [name, d.qty, round2(d.total)]);

      return NextResponse.json({
        key,
        title: key === "popular-items" ? "Popular items" : key === "slow-movers" ? "Slow movers" : "Sales by item",
        columns: ["Item Name", "Quantity Sold", "Total Sales (₹)"],
        rows,
      });
    }

    // 3. Sales by Category
    if (key === "sales-by-category") {
      const items = await fetchAllRows<any>((rangeFrom, rangeTo) => {
        let q = supabase
          .from("order_items")
          .select(`
            name_snapshot, quantity, line_total,
            menu_items(menu_categories(name)),
            orders!inner(status, created_at, branch_id)
          `)
          .eq("tenant_id", session!.tenantId)
          .eq("orders.status", "PAID")
          .gte("orders.created_at", fromDate)
          .lte("orders.created_at", toDate)
          .range(rangeFrom, rangeTo);
        if (branchId) q = q.eq("orders.branch_id", branchId);
        return q;
      });

      const catMap = new Map<string, { qty: number; total: number }>();

      for (const it of items) {
        const cleanName = (it.name_snapshot || "").toLowerCase().trim();
        const catName =
          it.menu_items?.menu_categories?.name ||
          seedCategoryMap.get(cleanName) ||
          "Other";

        if (!catMap.has(catName)) catMap.set(catName, { qty: 0, total: 0 });
        const cur = catMap.get(catName)!;
        cur.qty += Number(it.quantity || 1);
        cur.total += Number(it.line_total || 0);
      }

      const rows = Array.from(catMap.entries())
        .sort((a, b) => b[1].total - a[1].total)
        .map(([cat, d]) => [cat, d.qty, round2(d.total)]);

      return NextResponse.json({
        key,
        title: "Sales by category",
        columns: ["Category", "Items Sold", "Total Sales (₹)"],
        rows,
      });
    }

    // 4. Payment Methods Report
    if (key === "payment-methods") {
      const payments = await fetchAllRows<any>((rangeFrom, rangeTo) => {
        let q = supabase
          .from("payments")
          .select("method, amount, orders!inner(status, created_at, branch_id)")
          .eq("tenant_id", session!.tenantId)
          .eq("orders.status", "PAID")
          .gte("orders.created_at", fromDate)
          .lte("orders.created_at", toDate)
          .range(rangeFrom, rangeTo);
        if (branchId) q = q.eq("orders.branch_id", branchId);
        return q;
      });

      const payMap = new Map<string, { count: number; total: number }>();

      for (const p of payments) {
        const m = p.method || "CASH";
        if (!payMap.has(m)) payMap.set(m, { count: 0, total: 0 });
        const cur = payMap.get(m)!;
        cur.count++;
        cur.total += Number(p.amount || 0);
      }

      const rows = Array.from(payMap.entries())
        .sort((a, b) => b[1].total - a[1].total)
        .map(([method, d]) => [method, d.count, round2(d.total)]);

      return NextResponse.json({
        key,
        title: "Payment methods",
        columns: ["Payment Method", "Transactions", "Total Amount (₹)"],
        rows,
      });
    }

    // 5. Tax (GST) Summary
    if (key === "tax") {
      const orders = await fetchAllRows<any>((rangeFrom, rangeTo) => {
        let q = supabase
          .from("orders")
          .select("total_amount, tax_amount, subtotal")
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
        totalTaxable += Number(o.subtotal || 0);
        totalTax += Number(o.tax_amount || 0);
      }

      return NextResponse.json({
        key,
        title: "Tax (GST) summary",
        columns: ["Tax Slab", "Orders Count", "Taxable Value (₹)", "GST Collected (₹)", "Gross Total (₹)"],
        rows: [
          ["GST 5%", count, round2(totalTaxable), round2(totalTax), round2(totalTaxable + totalTax)],
        ],
      });
    }

    // 6. Peak Hours
    if (key === "peak-hours") {
      const orders = await fetchAllRows<any>((rangeFrom, rangeTo) => {
        let q = supabase
          .from("orders")
          .select("total_amount, created_at")
          .eq("tenant_id", session!.tenantId)
          .eq("status", "PAID")
          .gte("created_at", fromDate)
          .lte("created_at", toDate)
          .range(rangeFrom, rangeTo);
        if (branchId) q = q.eq("branch_id", branchId);
        return q;
      });

      const hourMap = new Map<number, { count: number; total: number }>();
      for (let h = 0; h < 24; h++) hourMap.set(h, { count: 0, total: 0 });

      for (const o of orders) {
        const hour = new Date(o.created_at).getHours();
        const cur = hourMap.get(hour) || { count: 0, total: 0 };
        cur.count++;
        cur.total += Number(o.total_amount || 0);
        hourMap.set(hour, cur);
      }

      const rows = Array.from(hourMap.entries())
        .sort((a, b) => b[1].total - a[1].total)
        .filter(([_, d]) => d.count > 0)
        .map(([h, d]) => [
          `${String(h).padStart(2, "0")}:00 - ${String(h + 1).padStart(2, "0")}:00`,
          d.count,
          round2(d.total),
        ]);

      return NextResponse.json({
        key,
        title: "Peak hours",
        columns: ["Time Window", "Orders", "Revenue (₹)"],
        rows,
      });
    }

    // 7. Customers
    if (key === "customers") {
      const orders = await fetchAllRows<any>((rangeFrom, rangeTo) => {
        let q = supabase
          .from("orders")
          .select("guest_name, total_amount")
          .eq("tenant_id", session!.tenantId)
          .eq("status", "PAID")
          .gte("created_at", fromDate)
          .lte("created_at", toDate)
          .range(rangeFrom, rangeTo);
        if (branchId) q = q.eq("branch_id", branchId);
        return q;
      });

      const guestMap = new Map<string, { count: number; total: number }>();

      for (const o of orders) {
        const g = o.guest_name || "Walk-in Guest";
        if (!guestMap.has(g)) guestMap.set(g, { count: 0, total: 0 });
        const cur = guestMap.get(g)!;
        cur.count++;
        cur.total += Number(o.total_amount || 0);
      }

      const rows = Array.from(guestMap.entries())
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 50)
        .map(([name, d]) => [name, d.count, round2(d.total)]);

      return NextResponse.json({
        key,
        title: "Top customers",
        columns: ["Customer / Guest", "Orders", "Total Spent (₹)"],
        rows,
      });
    }

    // Default fallback
    return NextResponse.json({
      key,
      title: "Report",
      columns: ["Metric", "Value"],
      rows: [["Total Period Orders", 0]],
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
