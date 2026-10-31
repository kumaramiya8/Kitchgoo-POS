import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    const { count, error } = await supabase
      .from("tenants")
      .select("id", { count: "exact", head: true });

    if (error) {
      console.warn("Supabase setup-status check:", error.message);
      return NextResponse.json({ isSetup: true });
    }

    return NextResponse.json({ isSetup: (count ?? 0) > 0 });
  } catch (err) {
    return NextResponse.json({ isSetup: true });
  }
}
