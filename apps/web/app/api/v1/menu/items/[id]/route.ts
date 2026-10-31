import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { id: itemId } = await params;
    const body = await req.json();
    const {
      categoryId,
      stationId,
      name,
      price,
      halfPrice,
      taxRatePercent,
      costPrice,
      prepTimeMinutes,
      isVeg,
      imageUrl,
      isActive,
      description,
      sku,
    } = body;

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (categoryId !== undefined) updates.category_id = categoryId;
    if (stationId !== undefined) updates.station_id = stationId || null;
    if (name !== undefined) updates.name = name.trim();
    if (price !== undefined) updates.price = Number(price);
    if (halfPrice !== undefined) updates.half_price = halfPrice != null ? Number(halfPrice) : null;
    if (taxRatePercent !== undefined) updates.tax_rate_percent = Number(taxRatePercent);
    if (costPrice !== undefined) updates.cost_price = costPrice != null ? Number(costPrice) : null;
    if (prepTimeMinutes !== undefined) updates.prep_time_minutes = Number(prepTimeMinutes);
    if (isVeg !== undefined) updates.is_veg = isVeg;
    if (imageUrl !== undefined) updates.image_url = imageUrl || null;
    if (isActive !== undefined) updates.is_active = isActive;
    if (description !== undefined) updates.description = description;
    if (sku !== undefined) updates.sku = sku;

    const supabase = getServerSupabase();
    const { data: updated, error } = await supabase
      .from("menu_items")
      .update(updates)
      .eq("id", itemId)
      .eq("tenant_id", session!.tenantId)
      .select("id, name, price, is_active")
      .single();

    if (error || !updated) {
      return NextResponse.json({ message: error?.message || "Item not found" }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { id: itemId } = await params;
    const supabase = getServerSupabase();

    const { error } = await supabase
      .from("menu_items")
      .delete()
      .eq("id", itemId)
      .eq("tenant_id", session!.tenantId);

    if (error) {
      return NextResponse.json({ message: error.message }, { status: 500 });
    }

    return new NextResponse(null, { status: 204 });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
