import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function PATCH(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const updates = await req.json();
    if (!Array.isArray(updates)) {
      return NextResponse.json({ message: "Expected array of table layout updates" }, { status: 400 });
    }

    const supabase = getServerSupabase();
    for (const u of updates) {
      if (u.id) {
        await supabase
          .from("tables")
          .update({
            pos_x: Number(u.posX ?? 0),
            pos_y: Number(u.posY ?? 0),
            width: Number(u.width ?? 80),
            height: Number(u.height ?? 80),
            rotation: Number(u.rotation ?? 0),
            updated_at: new Date().toISOString(),
          })
          .eq("id", u.id)
          .eq("tenant_id", session!.tenantId);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
