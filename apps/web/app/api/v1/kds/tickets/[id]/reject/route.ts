import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { id: kotId } = await params;
    const body = await req.json();
    const { reason } = body;

    const supabase = getServerSupabase();
    const { data: updated, error } = await supabase
      .from("kots")
      .update({
        status: "REJECTED",
        reject_reason: reason || "Kitchen rejected",
        updated_at: new Date().toISOString(),
      })
      .eq("id", kotId)
      .eq("tenant_id", session!.tenantId)
      .select("id, status")
      .single();

    if (error || !updated) {
      return NextResponse.json({ message: error?.message || "KOT not found" }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
