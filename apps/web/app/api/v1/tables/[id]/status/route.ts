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
    const { status } = body;

    if (!status) {
      return NextResponse.json({ message: "status is required" }, { status: 400 });
    }

    const supabase = getServerSupabase();
    const now = new Date().toISOString();
    const { data: updated, error } = await supabase
      .from("tables")
      .update({
        status,
        status_since: now,
        updated_at: now,
      })
      .eq("id", tableId)
      .eq("tenant_id", session!.tenantId)
      .select("id, status, status_since")
      .single();

    if (error || !updated) {
      return NextResponse.json({ message: error?.message || "Table not found" }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
