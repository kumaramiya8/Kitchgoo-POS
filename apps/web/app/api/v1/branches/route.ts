import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest, getAdminClient } from "@/lib/server-auth";
import { supabase } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const admin = getAdminClient();
    const client = admin ?? supabase;

    const { data: branches, error } = await client
      .from("branches")
      .select("id, name")
      .eq("tenant_id", session.tenantId)
      .eq("is_active", true)
      .order("created_at", { ascending: true });

    if (error) {
      return NextResponse.json({ message: error.message }, { status: 500 });
    }

    return NextResponse.json(branches || []);
  } catch (err: any) {
    return NextResponse.json(
      { message: err?.message || "Internal server error" },
      { status: 500 },
    );
  }
}
