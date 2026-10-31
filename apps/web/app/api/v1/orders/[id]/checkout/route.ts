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
    const body = await req.json();
    const { payments = [], tipAmount = 0 } = body;

    const supabase = getServerSupabase();

    // 1. Fetch current order
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("id, order_number, total_amount, subtotal, tax_amount, table_id, branch_id")
      .eq("id", orderId)
      .eq("tenant_id", session!.tenantId)
      .single();

    if (orderErr || !order) {
      return NextResponse.json({ message: "Order not found" }, { status: 404 });
    }

    const firstPayment = payments[0] || {};
    const method = firstPayment.method || "CASH";
    const totalPaid = payments.reduce((acc: number, p: any) => acc + Number(p.amount || 0), 0);
    const amountDue = Number(order.total_amount || 0);
    const tendered = firstPayment.tendered != null ? Number(firstPayment.tendered) : totalPaid;
    const changeDue = Math.max(0, tendered - amountDue);

    // 2. Try atomic settle_pos_order RPC
    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc("settle_pos_order", {
        p_order_id: orderId,
        p_payment_method: method,
        p_amount: totalPaid,
        p_tendered: tendered,
        p_change_given: changeDue,
        p_reference: firstPayment.reference || null,
      });

      if (!rpcErr && rpcData) {
        return NextResponse.json({
          id: orderId,
          orderNumber: order.order_number,
          status: "PAID",
          subtotal: String(order.subtotal),
          taxAmount: String(order.tax_amount),
          discountAmount: "0",
          tipAmount: String(tipAmount),
          loyaltyPointsRedeemed: 0,
          loyaltyDiscountAmount: "0",
          totalAmount: String(amountDue),
          settlement: {
            amountDue,
            amountPaid: totalPaid,
            balanceDue: Math.max(0, amountDue - totalPaid),
            changeDue,
            fullyPaid: totalPaid >= amountDue,
          },
        });
      }
    } catch {
      // Fallback to direct updates below
    }

    // 3. Fallback direct checkout:
    const now = new Date().toISOString();

    // Insert payment records
    for (const p of payments) {
      await supabase.from("payments").insert({
        tenant_id: session!.tenantId,
        branch_id: order.branch_id,
        order_id: orderId,
        method: p.method || "CASH",
        amount: Number(p.amount || totalPaid),
        tendered: p.tendered != null ? Number(p.tendered) : null,
        change_given: changeDue > 0 ? changeDue : null,
      });
    }

    // Update order status to PAID
    await supabase
      .from("orders")
      .update({
        status: "PAID",
        billed_at: now,
        tip_amount: Number(tipAmount || 0),
        updated_at: now,
      })
      .eq("id", orderId);

    // Mark table available
    if (order.table_id) {
      await supabase
        .from("tables")
        .update({
          status: "AVAILABLE",
          status_since: now,
          updated_at: now,
        })
        .eq("id", order.table_id);
    }

    // Mark active KOTs as SERVED
    await supabase
      .from("kots")
      .update({ status: "SERVED", updated_at: now })
      .eq("order_id", orderId);

    return NextResponse.json({
      id: orderId,
      orderNumber: order.order_number,
      status: "PAID",
      subtotal: String(order.subtotal),
      taxAmount: String(order.tax_amount),
      discountAmount: "0",
      tipAmount: String(tipAmount),
      loyaltyPointsRedeemed: 0,
      loyaltyDiscountAmount: "0",
      totalAmount: String(amountDue),
      settlement: {
        amountDue,
        amountPaid: totalPaid,
        balanceDue: Math.max(0, amountDue - totalPaid),
        changeDue,
        fullyPaid: totalPaid >= amountDue,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
