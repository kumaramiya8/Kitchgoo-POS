import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";
import { SEED_MENU_ITEMS } from "@/lib/seed-data";
import allInvoicesData from "@/lib/all-invoices.json";
import { ensureSeeded } from "@/lib/seed-service";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const supabase = getServerSupabase();

    // Check current counts for this tenant
    const { count: catCount } = await supabase
      .from("menu_categories")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", session!.tenantId);

    const { count: itemCount } = await supabase
      .from("menu_items")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", session!.tenantId);

    const { count: orderCount } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", session!.tenantId);

    return NextResponse.json({
      categoriesCount: catCount || 0,
      itemsCount: itemCount || 0,
      ordersCount: orderCount || 0,
      availableToImport: {
        menuItems: SEED_MENU_ITEMS.length,
        categories: Array.from(new Set(SEED_MENU_ITEMS.map((i) => i.category))).length,
        historicalInvoices: allInvoicesData.length,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");
    const supabase = getServerSupabase();

    const result = await ensureSeeded(supabase, session!.tenantId, branchId, true);

    return NextResponse.json({
      success: true,
      message: "Data import completed successfully!",
      result,
    });
  } catch (err: any) {
    console.error("Seed error:", err);
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
