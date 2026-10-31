import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");
    const supabase = getServerSupabase();

    let query = supabase
      .from("tables")
      .select("id, floor_id, number, name, capacity, status, status_since, pos_x, pos_y, width, height, rotation, shape, qr_token, assigned_waiter_id, created_at")
      .eq("tenant_id", session!.tenantId);

    if (branchId) {
      query = query.eq("branch_id", branchId);
    }

    const { data, error } = await query.order("number", { ascending: true });
    if (error) {
      return NextResponse.json({ message: error.message }, { status: 500 });
    }

    const tables = (data || []).map((t) => ({
      id: t.id,
      floorId: t.floor_id,
      number: String(t.number),
      name: t.name || `Table ${t.number}`,
      capacity: Number(t.capacity || 2),
      status: t.status || "AVAILABLE",
      statusSince: t.status_since || t.created_at || new Date().toISOString(),
      posX: Number(t.pos_x || 0),
      posY: Number(t.pos_y || 0),
      width: Number(t.width || 80),
      height: Number(t.height || 80),
      rotation: Number(t.rotation || 0),
      shape: t.shape || "square",
      qrToken: t.qr_token || null,
      assignedWaiter: t.assigned_waiter_id ? { id: t.assigned_waiter_id, name: "Staff" } : null,
    }));

    return NextResponse.json(tables);
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
    if (!branchId) {
      return NextResponse.json({ message: "branchId is required" }, { status: 400 });
    }

    const body = await req.json();
    const { floorId, number, name, capacity = 2, posX = 0, posY = 0, width = 80, height = 80, rotation = 0, shape = "square", color } = body;

    if (!floorId || !number) {
      return NextResponse.json({ message: "floorId and number are required" }, { status: 400 });
    }

    const supabase = getServerSupabase();
    const { data: newTable, error } = await supabase
      .from("tables")
      .insert({
        tenant_id: session!.tenantId,
        branch_id: branchId,
        floor_id: floorId,
        number: String(number),
        name: name || `Table ${number}`,
        capacity: Number(capacity),
        pos_x: Number(posX),
        pos_y: Number(posY),
        width: Number(width),
        height: Number(height),
        rotation: Number(rotation),
        shape,
        color: color || null,
        status: "AVAILABLE",
      })
      .select("id, floor_id, number, name, capacity, status, status_since, pos_x, pos_y, width, height, rotation, shape, qr_token, assigned_waiter_id")
      .single();

    if (error || !newTable) {
      return NextResponse.json({ message: error?.message || "Failed to create table" }, { status: 500 });
    }

    return NextResponse.json({
      id: newTable.id,
      floorId: newTable.floor_id,
      number: String(newTable.number),
      name: newTable.name,
      capacity: Number(newTable.capacity),
      status: newTable.status,
      statusSince: newTable.status_since,
      posX: Number(newTable.pos_x),
      posY: Number(newTable.pos_y),
      width: Number(newTable.width),
      height: Number(newTable.height),
      rotation: Number(newTable.rotation),
      shape: newTable.shape,
      qrToken: newTable.qr_token,
      assignedWaiter: null,
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
