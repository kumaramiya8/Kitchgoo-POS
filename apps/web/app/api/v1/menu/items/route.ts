import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const categoryId = searchParams.get("categoryId");

    const supabase = getServerSupabase();
    let query = supabase
      .from("menu_items")
      .select(`
        id, category_id, station_id, name, image_url, price, half_price,
        tax_rate_percent, is_veg, is_active, is_combo, sort_order,
        menu_categories(id, name),
        kitchen_stations(id, name)
      `)
      .eq("tenant_id", session!.tenantId)
      .eq("is_active", true);

    if (categoryId) {
      query = query.eq("category_id", categoryId);
    }

    const { data: items, error } = await query.order("sort_order", { ascending: true });
    if (error) {
      return NextResponse.json({ message: error.message }, { status: 500 });
    }

    const formatted = (items || []).map((i: any) => ({
      id: i.id,
      categoryId: i.category_id,
      stationId: i.station_id || null,
      name: i.name,
      imageUrl: i.image_url || null,
      price: String(i.price),
      halfPrice: i.half_price != null ? String(i.half_price) : null,
      taxRatePercent: String(i.tax_rate_percent ?? "0"),
      isVeg: i.is_veg ?? true,
      isActive: i.is_active ?? true,
      isCombo: i.is_combo ?? false,
      category: {
        id: i.category_id,
        name: i.menu_categories?.name || "",
      },
      station: i.kitchen_stations
        ? {
            id: i.kitchen_stations.id,
            name: i.kitchen_stations.name,
          }
        : null,
      modifierGroups: [],
    }));

    return NextResponse.json(formatted);
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
    const {
      categoryId,
      stationId,
      name,
      price,
      halfPrice,
      taxRatePercent = 0,
      costPrice,
      prepTimeMinutes = 15,
      isVeg = true,
      imageUrl,
      isActive = true,
      description,
      sku,
    } = body;

    if (!categoryId || !name || price === undefined) {
      return NextResponse.json(
        { message: "categoryId, name, and price are required" },
        { status: 400 },
      );
    }

    const supabase = getServerSupabase();
    const { data: newItem, error } = await supabase
      .from("menu_items")
      .insert({
        tenant_id: session!.tenantId,
        branch_id: branchId || null,
        category_id: categoryId,
        station_id: stationId || null,
        name: name.trim(),
        price: Number(price),
        half_price: halfPrice != null ? Number(halfPrice) : null,
        tax_rate_percent: Number(taxRatePercent),
        cost_price: costPrice != null ? Number(costPrice) : null,
        prep_time_minutes: Number(prepTimeMinutes),
        is_veg: isVeg,
        image_url: imageUrl || null,
        is_active: isActive,
        description: description || null,
        sku: sku || null,
      })
      .select(`
        id, category_id, station_id, name, image_url, price, half_price,
        tax_rate_percent, is_veg, is_active, is_combo,
        menu_categories(id, name),
        kitchen_stations(id, name)
      `)
      .single();

    if (error || !newItem) {
      return NextResponse.json({ message: error?.message || "Failed to create menu item" }, { status: 500 });
    }

    return NextResponse.json({
      id: newItem.id,
      categoryId: newItem.category_id,
      stationId: newItem.station_id || null,
      name: newItem.name,
      imageUrl: newItem.image_url || null,
      price: String(newItem.price),
      halfPrice: newItem.half_price != null ? String(newItem.half_price) : null,
      taxRatePercent: String(newItem.tax_rate_percent ?? "0"),
      isVeg: newItem.is_veg,
      isActive: newItem.is_active,
      isCombo: newItem.is_combo ?? false,
      category: {
        id: newItem.category_id,
        name: (newItem as any).menu_categories?.name || "",
      },
      station: (newItem as any).kitchen_stations
        ? {
            id: (newItem as any).kitchen_stations.id,
            name: (newItem as any).kitchen_stations.name,
          }
        : null,
      modifierGroups: [],
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
