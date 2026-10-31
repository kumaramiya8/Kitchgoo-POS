import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { id: tableId } = await params;
    const body = await req.json();
    const { number, name, capacity, shape, color, posX, posY, width, height, rotation } = body;

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (number !== undefined) updates.number = String(number);
    if (name !== undefined) updates.name = name;
    if (capacity !== undefined) updates.capacity = Number(capacity);
    if (shape !== undefined) updates.shape = shape;
    if (color !== undefined) updates.color = color;
    if (posX !== undefined) updates.pos_x = Number(posX);
    if (posY !== undefined) updates.pos_y = Number(posY);
    if (width !== undefined) updates.width = Number(width);
    if (height !== undefined) updates.height = Number(height);
    if (rotation !== undefined) updates.rotation = Number(rotation);

    const supabase = getServerSupabase();
    const { data: updated, error } = await supabase
      .from("tables")
      .update(updates)
      .eq("id", tableId)
      .eq("tenant_id", session!.tenantId)
      .select("id, floor_id, number, name, capacity, status, status_since, pos_x, pos_y, width, height, rotation, shape, qr_token")
      .single();

    if (error || !updated) {
      return NextResponse.json({ message: error?.message || "Table not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: updated.id,
      floorId: updated.floor_id,
      number: String(updated.number),
      name: updated.name,
      capacity: Number(updated.capacity),
      status: updated.status,
      statusSince: updated.status_since,
      posX: Number(updated.pos_x),
      posY: Number(updated.pos_y),
      width: Number(updated.width),
      height: Number(updated.height),
      rotation: Number(updated.rotation),
      shape: updated.shape,
      qrToken: updated.qr_token,
      assignedWaiter: null,
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

    const { id: tableId } = await params;
    const supabase = getServerSupabase();

    const { error } = await supabase
      .from("tables")
      .delete()
      .eq("id", tableId)
      .eq("tenant_id", session!.tenantId);

    if (error) {
      return NextResponse.json({ message: error.message }, { status: 500 });
    }

    return new NextResponse(null, { status: 204 });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
