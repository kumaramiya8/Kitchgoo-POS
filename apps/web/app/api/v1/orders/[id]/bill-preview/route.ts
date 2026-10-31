import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { id: orderId } = await params;
    const body = await req.json().catch(() => ({}));
    const { discountPercent = 0, tipAmount = 0 } = body;

    const supabase = getServerSupabase();
    const { data: order, error } = await supabase
      .from("orders")
      .select("id, status, subtotal, tax_amount, total_amount")
      .eq("id", orderId)
      .eq("tenant_id", session!.tenantId)
      .single();

    if (error || !order) {
      return NextResponse.json({ message: "Order not found" }, { status: 404 });
    }

    const subtotal = Number(order.subtotal || 0);
    const taxAmount = Number(order.tax_amount || 0);
    const tip = Number(tipAmount || 0);
    const discountAmt = discountPercent > 0 ? (subtotal * discountPercent) / 100 : 0;
    const totalDue = Math.max(0, subtotal - discountAmt + taxAmount + tip);

    return NextResponse.json({
      locked: order.status === "PAID",
      status: order.status,
      subtotal,
      discountAmount: discountAmt,
      discountPercent: Number(discountPercent),
      discountType: discountPercent > 0 ? "PERCENT" : null,
      discountValue: discountPercent > 0 ? Number(discountPercent) : null,
      couponCode: null,
      promotionName: null,
      taxAmount,
      loyaltyPointsRedeemed: 0,
      loyaltyDiscountAmount: 0,
      tipAmount: tip,
      deliveryFee: 0,
      totalDue,
      amountPaid: 0,
      balanceDue: totalDue,
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
