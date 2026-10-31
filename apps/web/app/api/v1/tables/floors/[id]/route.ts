import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { id: floorId } = await params;
    const body = await req.json();
    const { name, sortOrder } = body;

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name.trim();
    if (sortOrder !== undefined) updates.sort_order = sortOrder;

    const supabase = getServerSupabase();
    const { data: updated, error } = await supabase
      .from("floors")
      .update(updates)
      .eq("id", floorId)
      .eq("tenant_id", session!.tenantId)
      .select("id, name, sort_order")
      .single();

    if (error || !updated) {
      return NextResponse.json({ message: error?.message || "Floor not found" }, { status: 404 });
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

    const { id: floorId } = await params;
    const supabase = getServerSupabase();

    const { error } = await supabase
      .from("floors")
      .delete()
      .eq("id", floorId)
      .eq("tenant_id", session!.tenantId);

    if (error) {
      return NextResponse.json({ message: error.message }, { status: 500 });
    }

    return new NextResponse(null, { status: 204 });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
