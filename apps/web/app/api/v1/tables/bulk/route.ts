import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

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
    const { floorId, numbers, capacity = 2, shape = "square", color } = body;

    if (!floorId || !Array.isArray(numbers) || numbers.length === 0) {
      return NextResponse.json({ message: "floorId and numbers array are required" }, { status: 400 });
    }

    const supabase = getServerSupabase();
    // Layout tables dynamically with clean spacing
    const rows = numbers.map((num: string, idx: number) => {
      const col = idx % 5;
      const row = Math.floor(idx / 5);
      return {
        tenant_id: session!.tenantId,
        branch_id: branchId,
        floor_id: floorId,
        number: String(num),
        name: `Table ${num}`,
        capacity: Number(capacity),
        pos_x: 40 + col * 140,
        pos_y: 40 + row * 140,
        width: 80,
        height: 80,
        shape,
        color: color || null,
        status: "AVAILABLE",
      };
    });

    const { data, error } = await supabase.from("tables").insert(rows).select("id");
    if (error) {
      return NextResponse.json({ message: error.message }, { status: 500 });
    }

    return NextResponse.json({ count: data?.length ?? 0 });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
