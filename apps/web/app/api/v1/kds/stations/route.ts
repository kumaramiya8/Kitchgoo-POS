import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");
    if (!branchId) {
      return NextResponse.json([{ id: "main-kitchen", name: "Main Kitchen" }]);
    }

    const supabase = getServerSupabase();
    let { data: stations, error } = await supabase
      .from("kitchen_stations")
      .select("id, name")
      .eq("tenant_id", session!.tenantId)
      .eq("branch_id", branchId)
      .order("name", { ascending: true });

    if (error || !stations || stations.length === 0) {
      // Auto-provision default Main Kitchen station
      const { data: newStation } = await supabase
        .from("kitchen_stations")
        .insert({
          tenant_id: session!.tenantId,
          branch_id: branchId,
          name: "Main Kitchen",
        })
        .select("id, name")
        .single();

      stations = newStation ? [newStation] : [{ id: "main-kitchen", name: "Main Kitchen" }];
    }

    return NextResponse.json(stations);
  } catch (err: any) {
    return NextResponse.json([{ id: "main-kitchen", name: "Main Kitchen" }]);
  }
}
