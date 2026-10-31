import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey);
}

export async function POST(req: NextRequest) {
  try {
    const signature = req.headers.get("x-webhook-signature");
    const secret = process.env.BILLING_WEBHOOK_SECRET;

    if (secret && signature !== secret) {
      return NextResponse.json({ message: "Invalid signature" }, { status: 401 });
    }

    const payload = await req.json();
    const { tenantId, tier, status } = payload;

    const admin = getAdminClient();
    if (admin && tenantId) {
      await admin
        .from("tenants")
        .update({
          subscription_tier: tier ?? "standard",
          is_active: status === "active",
          updated_at: new Date().toISOString(),
        })
        .eq("id", tenantId);
    }

    return NextResponse.json({ received: true });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message }, { status: 500 });
  }
}
