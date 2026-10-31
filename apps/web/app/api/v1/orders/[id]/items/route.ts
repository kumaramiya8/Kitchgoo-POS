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
    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");

    const body = await req.json();
    const { items } = body;
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ message: "Items array is required" }, { status: 400 });
    }

    const supabase = getServerSupabase();

    // 1. Fetch current order
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("id, subtotal, tax_amount, total_amount, branch_id")
      .eq("id", orderId)
      .eq("tenant_id", session!.tenantId)
      .single();

    if (orderErr || !order) {
      return NextResponse.json({ message: "Order not found" }, { status: 404 });
    }

    const effectiveBranchId = branchId || order.branch_id;

    // 2. Fetch menu item prices
    const itemIds = items.map((i: any) => i.menuItemId);
    const { data: menuData } = await supabase
      .from("menu_items")
      .select("id, name, price, tax_rate_percent")
      .in("id", itemIds);

    const priceMap = new Map((menuData || []).map((m: any) => [m.id, m]));

    let addedSubtotal = 0;
    let addedTax = 0;
    const orderItemInserts = items.map((cartItem: any) => {
      const info = priceMap.get(cartItem.menuItemId) as any;
      const unitPrice = info ? Number(info.price) : 0;
      const taxRate = info ? Number(info.tax_rate_percent || 0) : 0;
      const qty = Number(cartItem.quantity || 1);
      const lineTotal = unitPrice * qty;
      const lineTax = (lineTotal * taxRate) / 100;

      addedSubtotal += lineTotal;
      addedTax += lineTax;

      return {
        tenant_id: session!.tenantId,
        order_id: orderId,
        menu_item_id: cartItem.menuItemId,
        name_snapshot: info?.name || "Item",
        unit_price_snapshot: unitPrice,
        tax_rate_snapshot: taxRate,
        quantity: qty,
        line_total: lineTotal,
        kitchen_note: cartItem.kitchenNote || null,
        status: "NEW",
      };
    });

    const { data: createdItems } = await supabase.from("order_items").insert(orderItemInserts).select("id");

    // Update order totals
    const newSubtotal = Number(order.subtotal || 0) + addedSubtotal;
    const newTax = Number(order.tax_amount || 0) + addedTax;
    const newTotal = newSubtotal + newTax;

    await supabase
      .from("orders")
      .update({
        subtotal: newSubtotal,
        tax_amount: newTax,
        total_amount: newTotal,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId);

    // Create KOT for added items
    const kotNumber = `KOT-${Math.floor(100 + Math.random() * 900)}`;
    const { data: newKot } = await supabase
      .from("kots")
      .insert({
        tenant_id: session!.tenantId,
        branch_id: effectiveBranchId,
        order_id: orderId,
        ticket_number: kotNumber,
        status: "NEW",
      })
      .select("id")
      .single();

    if (newKot && createdItems) {
      const kotItems = createdItems.map((ci: any) => ({
        tenant_id: session!.tenantId,
        kot_id: newKot.id,
        order_item_id: ci.id,
        status: "NEW",
      }));
      await supabase.from("kot_items").insert(kotItems);
    }

    return NextResponse.json({
      id: orderId,
      subtotal: String(newSubtotal),
      taxAmount: String(newTax),
      totalAmount: String(newTotal),
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
