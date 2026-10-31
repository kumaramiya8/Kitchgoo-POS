import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const supabase = getServerSupabase();
    const { data: categories, error } = await supabase
      .from("menu_categories")
      .select("id, name, sort_order, is_active, show_on_website")
      .eq("tenant_id", session!.tenantId)
      .order("sort_order", { ascending: true });

    if (error) {
      return NextResponse.json({ message: error.message }, { status: 500 });
    }

    // Get item counts per category
    const { data: itemCounts } = await supabase
      .from("menu_items")
      .select("category_id")
      .eq("tenant_id", session!.tenantId);

    const counts: Record<string, number> = {};
    for (const item of itemCounts || []) {
      counts[item.category_id] = (counts[item.category_id] || 0) + 1;
    }

    const result = (categories || []).map((c) => ({
      id: c.id,
      name: c.name,
      sortOrder: c.sort_order ?? 0,
      isActive: c.is_active ?? true,
      showOnWebsite: c.show_on_website ?? true,
      _count: { items: counts[c.id] || 0 },
    }));

    return NextResponse.json(result);
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

    const body = await req.json();
    const { name, sortOrder = 0, isActive = true, showOnWebsite = true } = body;

    if (!name) {
      return NextResponse.json({ message: "Category name is required" }, { status: 400 });
    }

    const supabase = getServerSupabase();
    const { data: newCat, error } = await supabase
      .from("menu_categories")
      .insert({
        tenant_id: session!.tenantId,
        branch_id: branchId || null,
        name: name.trim(),
        sort_order: sortOrder,
        is_active: isActive,
        show_on_website: showOnWebsite,
      })
      .select("id, name, sort_order, is_active, show_on_website")
      .single();

    if (error || !newCat) {
      return NextResponse.json({ message: error?.message || "Failed to create category" }, { status: 500 });
    }

    return NextResponse.json({
      id: newCat.id,
      name: newCat.name,
      sortOrder: newCat.sort_order,
      isActive: newCat.is_active,
      showOnWebsite: newCat.show_on_website,
      _count: { items: 0 },
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
