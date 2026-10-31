import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-db";

export async function GET(req: NextRequest) {
  try {
    const { errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    return NextResponse.json([]);
  } catch (err: any) {
    return NextResponse.json([]);
  }
}
