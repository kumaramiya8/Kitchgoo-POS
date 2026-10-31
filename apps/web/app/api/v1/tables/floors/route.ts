import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    let branchId = searchParams.get("branchId");
    const supabase = getServerSupabase();

    // If branchId is not provided, fetch the default branch for this tenant
    if (!branchId) {
      const { data: firstBranch } = await supabase
        .from("branches")
        .select("id")
        .eq("tenant_id", session!.tenantId)
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .single();
      branchId = firstBranch?.id ?? null;
    }

    if (!branchId) {
      return NextResponse.json([]);
    }

    // 1. Fetch floors
    let { data: floors, error: floorError } = await supabase
      .from("floors")
      .select("id, name, sort_order")
      .eq("tenant_id", session!.tenantId)
      .eq("branch_id", branchId)
      .order("sort_order", { ascending: true });

    if (floorError) {
      return NextResponse.json({ message: floorError.message }, { status: 500 });
    }

    // 2. Auto-provision starter floor & tables if none exist yet
    if (!floors || floors.length === 0) {
      const { data: newFloor, error: createFloorError } = await supabase
        .from("floors")
        .insert({
          tenant_id: session!.tenantId,
          branch_id: branchId,
          name: "Main Dining",
          sort_order: 0,
        })
        .select("id, name, sort_order")
        .single();

      if (!createFloorError && newFloor) {
        floors = [newFloor];
        const starterTables = [
          { number: "1", name: "Table 1", capacity: 2, pos_x: 40, pos_y: 40, width: 80, height: 80, shape: "square" },
          { number: "2", name: "Table 2", capacity: 2, pos_x: 180, pos_y: 40, width: 80, height: 80, shape: "square" },
          { number: "3", name: "Table 3", capacity: 4, pos_x: 320, pos_y: 40, width: 80, height: 80, shape: "square" },
          { number: "4", name: "Table 4", capacity: 4, pos_x: 460, pos_y: 40, width: 80, height: 80, shape: "square" },
          { number: "5", name: "Table 5", capacity: 4, pos_x: 40, pos_y: 180, width: 80, height: 80, shape: "square" },
          { number: "6", name: "Table 6", capacity: 4, pos_x: 180, pos_y: 180, width: 80, height: 80, shape: "square" },
          { number: "7", name: "Table 7", capacity: 6, pos_x: 320, pos_y: 180, width: 120, height: 80, shape: "rect" },
          { number: "8", name: "Table 8", capacity: 6, pos_x: 480, pos_y: 180, width: 120, height: 80, shape: "rect" },
        ].map((t) => ({
          tenant_id: session!.tenantId,
          branch_id: branchId,
          floor_id: newFloor.id,
          status: "AVAILABLE",
          ...t,
        }));

        await supabase.from("tables").insert(starterTables);
      }
    }

    // 3. Fetch all tables for the branch
    const { data: tablesData, error: tablesError } = await supabase
      .from("tables")
      .select("id, floor_id, number, name, capacity, status, status_since, pos_x, pos_y, width, height, rotation, shape, qr_token, assigned_waiter_id, created_at")
      .eq("tenant_id", session!.tenantId)
      .eq("branch_id", branchId)
      .order("number", { ascending: true });

    if (tablesError) {
      return NextResponse.json({ message: tablesError.message }, { status: 500 });
    }

    const tablesByFloor: Record<string, any[]> = {};
    for (const t of tablesData || []) {
      const fId = t.floor_id;
      if (!tablesByFloor[fId]) tablesByFloor[fId] = [];
      tablesByFloor[fId].push({
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
      });
    }

    const result = (floors || []).map((f) => ({
      id: f.id,
      name: f.name,
      sortOrder: f.sort_order ?? 0,
      tables: tablesByFloor[f.id] || [],
    }));

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Floors GET error:", err);
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
    const { name, sortOrder = 0 } = body;
    if (!name || typeof name !== "string") {
      return NextResponse.json({ message: "name is required" }, { status: 400 });
    }

    const supabase = getServerSupabase();
    const { data: newFloor, error } = await supabase
      .from("floors")
      .insert({
        tenant_id: session!.tenantId,
        branch_id: branchId,
        name: name.trim(),
        sort_order: sortOrder,
      })
      .select("id, name, sort_order")
      .single();

    if (error || !newFloor) {
      return NextResponse.json({ message: error?.message || "Failed to create floor" }, { status: 500 });
    }

    return NextResponse.json({
      id: newFloor.id,
      name: newFloor.name,
      sortOrder: newFloor.sort_order,
      tables: [],
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
