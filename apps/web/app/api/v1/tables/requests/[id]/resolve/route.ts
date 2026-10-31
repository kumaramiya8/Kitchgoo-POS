import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-db";

export async function PATCH(req: NextRequest) {
  try {
    const { errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
