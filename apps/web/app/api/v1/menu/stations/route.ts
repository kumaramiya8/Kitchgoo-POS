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
      .from("kitchen_stations")
      .select("id, name")
      .eq("tenant_id", session!.tenantId);

    if (branchId) {
      query = query.eq("branch_id", branchId);
    }

    const { data: stations } = await query;
    return NextResponse.json(stations || [{ id: "main-kitchen", name: "Main Kitchen" }]);
  } catch (err: any) {
    return NextResponse.json([{ id: "main-kitchen", name: "Main Kitchen" }]);
  }
}
