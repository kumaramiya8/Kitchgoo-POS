import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { id: categoryId } = await params;
    const body = await req.json();
    const { name, sortOrder, isActive, showOnWebsite } = body;

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name.trim();
    if (sortOrder !== undefined) updates.sort_order = sortOrder;
    if (isActive !== undefined) updates.is_active = isActive;
    if (showOnWebsite !== undefined) updates.show_on_website = showOnWebsite;

    const supabase = getServerSupabase();
    const { data: updated, error } = await supabase
      .from("menu_categories")
      .update(updates)
      .eq("id", categoryId)
      .eq("tenant_id", session!.tenantId)
      .select("id, name, sort_order, is_active, show_on_website")
      .single();

    if (error || !updated) {
      return NextResponse.json({ message: error?.message || "Category not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      sortOrder: updated.sort_order,
      isActive: updated.is_active,
      showOnWebsite: updated.show_on_website,
    });
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

    const { id: categoryId } = await params;
    const supabase = getServerSupabase();

    const { error } = await supabase
      .from("menu_categories")
      .delete()
      .eq("id", categoryId)
      .eq("tenant_id", session!.tenantId);

    if (error) {
      return NextResponse.json({ message: error.message }, { status: 500 });
    }

    return new NextResponse(null, { status: 204 });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
