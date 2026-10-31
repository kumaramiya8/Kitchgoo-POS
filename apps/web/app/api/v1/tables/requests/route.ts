import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-db";

export async function GET(req: NextRequest) {
  try {
    const { errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    // Table requests (waiter/bill calls) - return empty array when none are pending
    return NextResponse.json([]);
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
