import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");
    const tableId = searchParams.get("tableId");

    const supabase = getServerSupabase();
    let query = supabase
      .from("orders")
      .select(`
        id, order_number, type, table_id, subtotal, tax_amount,
        discount_amount, total_amount, status, created_at,
        customers(id, name, phone)
      `)
      .eq("tenant_id", session!.tenantId)
      .in("status", ["OPEN", "BILLED"])
      .order("created_at", { ascending: false });

    if (branchId) {
      query = query.eq("branch_id", branchId);
    }
    if (tableId) {
      query = query.eq("table_id", tableId);
    }

    const { data: orders, error } = await query;
    if (error) {
      return NextResponse.json({ message: error.message }, { status: 500 });
    }

    const result = (orders || []).map((o: any) => ({
      id: o.id,
      orderNumber: o.order_number,
      type: o.type,
      tableId: o.table_id || null,
      subtotal: String(o.subtotal || 0),
      taxAmount: String(o.tax_amount || 0),
      discountAmount: String(o.discount_amount || 0),
      tipAmount: "0",
      loyaltyPointsRedeemed: 0,
      loyaltyDiscountAmount: "0",
      totalAmount: String(o.total_amount || 0),
      status: o.status,
      customer: o.customers
        ? {
            id: o.customers.id,
            name: o.customers.name,
            phone: o.customers.phone,
          }
        : null,
    }));

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");
    if (!branchId) {
      return NextResponse.json({ message: "branchId is required" }, { status: 400 });
    }

    const body = await req.json();
    const { type = "DINE_IN", tableId, guestCount, guestName, notes, items } = body;

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ message: "Order must contain at least one item" }, { status: 400 });
    }

    const supabase = getServerSupabase();

    // 1. Try atomic create_pos_order RPC
    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc("create_pos_order", {
        p_branch_id: branchId,
        p_type: type,
        p_table_id: tableId || null,
        p_guest_count: guestCount ? Number(guestCount) : null,
        p_guest_name: guestName || null,
        p_customer_id: null,
        p_notes: notes || null,
        p_items: items.map((i: any) => ({
          menu_item_id: i.menuItemId,
          quantity: Number(i.quantity || 1),
          kitchen_note: i.kitchenNote || null,
          modifier_ids: i.modifierIds || [],
        })),
        p_auto_occupy_table: true,
        p_deduct_inventory: false,
      });

      if (!rpcErr && rpcData) {
        const res = rpcData as any;
        return NextResponse.json({
          id: res.order_id,
          orderNumber: res.order_number,
          totalAmount: String(res.total_amount || 0),
          subtotal: String(res.total_amount || 0),
          taxAmount: "0",
          discountAmount: "0",
          tipAmount: "0",
          loyaltyPointsRedeemed: 0,
          loyaltyDiscountAmount: "0",
          status: res.status || "OPEN",
        });
      }
    } catch {
      // Fallback to direct insertion below
    }

    // 2. Fallback: Direct table insertion
    const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, "");
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const orderNumber = `ORD-${dateStr}-${randomSuffix}`;

    // Fetch menu item prices
    const itemIds = items.map((i: any) => i.menuItemId);
    const { data: menuData } = await supabase
      .from("menu_items")
      .select("id, name, price, tax_rate_percent, station_id")
      .in("id", itemIds);

    const priceMap = new Map((menuData || []).map((m: any) => [m.id, m]));

    let subtotal = 0;
    let taxAmount = 0;
    const orderItemInserts = items.map((cartItem: any) => {
      const info = priceMap.get(cartItem.menuItemId) as any;
      const unitPrice = info ? Number(info.price) : 0;
      const taxRate = info ? Number(info.tax_rate_percent || 0) : 0;
      const qty = Number(cartItem.quantity || 1);
      const lineTotal = unitPrice * qty;
      const lineTax = (lineTotal * taxRate) / 100;

      subtotal += lineTotal;
      taxAmount += lineTax;

      return {
        tenant_id: session!.tenantId,
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

    const totalAmount = subtotal + taxAmount;

    // Create Order
    const { data: newOrder, error: orderErr } = await supabase
      .from("orders")
      .insert({
        tenant_id: session!.tenantId,
        branch_id: branchId,
        order_number: orderNumber,
        type,
        status: "OPEN",
        channel: "STAFF",
        table_id: tableId || null,
        guest_count: guestCount ? Number(guestCount) : null,
        guest_name: guestName || null,
        notes: notes || null,
        subtotal,
        tax_amount: taxAmount,
        total_amount: totalAmount,
      })
      .select("id, order_number, total_amount, subtotal, tax_amount, status")
      .single();

    if (orderErr || !newOrder) {
      return NextResponse.json({ message: orderErr?.message || "Failed to create order" }, { status: 500 });
    }

    // Insert order items
    const itemsToInsert = orderItemInserts.map((oi) => ({
      ...oi,
      order_id: newOrder.id,
    }));
    const { data: createdItems } = await supabase.from("order_items").insert(itemsToInsert).select("id");

    // Create KOT
    const kotNumber = `KOT-${Math.floor(100 + Math.random() * 900)}`;
    const { data: newKot } = await supabase
      .from("kots")
      .insert({
        tenant_id: session!.tenantId,
        branch_id: branchId,
        order_id: newOrder.id,
        ticket_number: kotNumber,
        status: "NEW",
      })
      .select("id")
      .single();

    if (newKot && createdItems) {
      const kotItemsToInsert = createdItems.map((ci: any) => ({
        tenant_id: session!.tenantId,
        kot_id: newKot.id,
        order_item_id: ci.id,
        status: "NEW",
      }));
      await supabase.from("kot_items").insert(kotItemsToInsert);
    }

    // Mark table occupied
    if (tableId) {
      await supabase
        .from("tables")
        .update({ status: "OCCUPIED", status_since: new Date().toISOString() })
        .eq("id", tableId)
        .eq("tenant_id", session!.tenantId);
    }

    return NextResponse.json({
      id: newOrder.id,
      orderNumber: newOrder.order_number,
      totalAmount: String(newOrder.total_amount),
      subtotal: String(newOrder.subtotal),
      taxAmount: String(newOrder.tax_amount),
      discountAmount: "0",
      tipAmount: "0",
      loyaltyPointsRedeemed: 0,
      loyaltyDiscountAmount: "0",
      status: newOrder.status,
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
