import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { id: orderId } = await params;
    const supabase = getServerSupabase();

    const { data: order, error } = await supabase
      .from("orders")
      .select(`
        id, order_number, type, status, channel, acceptance,
        guest_count, guest_name, subtotal, tax_amount, discount_amount,
        tip_amount, total_amount, created_at, notes,
        tables(id, number, name),
        customers(id, name, phone, email),
        order_items(
          id, menu_item_id, name_snapshot, quantity, unit_price_snapshot,
          line_total, kitchen_note,
          order_item_modifiers(id, name_snapshot, price_adj_snapshot)
        ),
        kots(
          id, status, printed_count, reject_reason,
          kot_items(order_item_id, status)
        ),
        payments(id, method, amount, tendered, change_given, created_at)
      `)
      .eq("id", orderId)
      .eq("tenant_id", session!.tenantId)
      .single();

    if (error || !order) {
      return NextResponse.json({ message: error?.message || "Order not found" }, { status: 404 });
    }

    const o = order as any;
    const result = {
      id: o.id,
      orderNumber: o.order_number,
      type: o.type,
      status: o.status,
      channel: o.channel || "STAFF",
      acceptance: o.acceptance || "NOT_REQUIRED",
      guestCount: o.guest_count,
      guestName: o.guest_name,
      subtotal: String(o.subtotal || 0),
      taxAmount: String(o.tax_amount || 0),
      discountAmount: String(o.discount_amount || 0),
      tipAmount: String(o.tip_amount || 0),
      totalAmount: String(o.total_amount || 0),
      createdAt: o.created_at,
      notes: o.notes,
      table: o.tables
        ? { id: o.tables.id, number: Number(o.tables.number) || 0, name: o.tables.name }
        : null,
      customer: o.customers
        ? { id: o.customers.id, name: o.customers.name, phone: o.customers.phone, email: o.customers.email }
        : null,
      items: (o.order_items || []).map((i: any) => ({
        id: i.id,
        menuItemId: i.menu_item_id,
        nameSnapshot: i.name_snapshot,
        quantity: i.quantity,
        unitPriceSnapshot: String(i.unit_price_snapshot || 0),
        lineTotal: String(i.line_total || 0),
        kitchenNote: i.kitchen_note,
        modifiers: (i.order_item_modifiers || []).map((m: any) => ({
          id: m.id,
          nameSnapshot: m.name_snapshot,
          priceAdjSnapshot: String(m.price_adj_snapshot || 0),
        })),
      })),
      kots: (o.kots || []).map((k: any) => ({
        id: k.id,
        status: k.status,
        printedCount: k.printed_count || 0,
        rejectReason: k.reject_reason,
        items: (k.kot_items || []).map((ki: any) => ({
          orderItemId: ki.order_item_id,
          status: ki.status,
        })),
      })),
      payments: (o.payments || []).map((p: any) => ({
        id: p.id,
        method: p.method,
        amount: String(p.amount || 0),
        tendered: p.tendered != null ? String(p.tendered) : null,
        changeGiven: p.change_given != null ? String(p.change_given) : null,
        createdAt: p.created_at,
      })),
    };

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
