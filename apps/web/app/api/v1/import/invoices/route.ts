import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";
import allInvoicesData from "@/lib/all-invoices.json";
import { ensureSeeded } from "@/lib/seed-service";

export const maxDuration = 60;

export interface InvoiceRecord {
  saleDate: string;
  invoiceNo: string;
  guestName: string;
  paymentType: string;
  totalSales: number;
  totalTax: number;
  items: { itemName: string; qty: number; incTax: number }[];
}

function cleanItemName(name: string): string {
  let cleaned = name.trim();
  cleaned = cleaned.replace(/\.\d+$/, "");
  cleaned = cleaned.replace(/\.+$/, "");
  return cleaned.trim();
}

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");
    const supabase = getServerSupabase();

    let query = supabase
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", session!.tenantId);

    if (branchId) {
      query = query.eq("branch_id", branchId);
    }

    const { count: importedCount } = await query;

    return NextResponse.json({
      importedCount: importedCount || 0,
      totalBundled: allInvoicesData.length,
      remainingBundled: Math.max(0, allInvoicesData.length - (importedCount || 0)),
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    let branchId = searchParams.get("branchId");
    const supabase = getServerSupabase();

    if (!branchId) {
      const { data: firstBranch } = await supabase
        .from("branches")
        .select("id")
        .eq("tenant_id", session!.tenantId)
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .single();
      branchId = firstBranch?.id ?? null;
    }

    if (!branchId) {
      return NextResponse.json({ message: "No active branch found" }, { status: 400 });
    }

    const tenantId = session!.tenantId;
    const body = await req.json().catch(() => ({}));

    // If requested to import all bundled at once
    if (body.all === true || body.autoAll === true) {
      const seedResult = await ensureSeeded(supabase, tenantId, branchId, true);
      return NextResponse.json({
        success: true,
        importedCount: seedResult.importedOrders || 0,
        result: seedResult,
        message: "Successfully seeded all historical data!",
      });
    }

    // Invoices to process: either custom provided array (from CSV upload) or slice from pre-bundled dataset
    let invoicesToProcess: InvoiceRecord[] = [];
    if (Array.isArray(body.invoices) && body.invoices.length > 0) {
      // First ensure menu items exist
      await ensureSeeded(supabase, tenantId, branchId, false);
      invoicesToProcess = body.invoices;
    } else {
      const offset = Number(body.offset || 0);
      const limit = Number(body.limit || 200);
      invoicesToProcess = (allInvoicesData as InvoiceRecord[]).slice(offset, offset + limit);
    }

    if (invoicesToProcess.length === 0) {
      return NextResponse.json({
        success: true,
        importedCount: 0,
        message: "No invoices to process in this batch.",
      });
    }

    // 1. Fetch existing order numbers in this branch to skip duplicates
    const invoiceNumbers = invoicesToProcess.map((inv) => inv.invoiceNo);
    const { data: existingOrders } = await supabase
      .from("orders")
      .select("order_number")
      .eq("tenant_id", tenantId)
      .eq("branch_id", branchId)
      .in("order_number", invoiceNumbers);

    const existingSet = new Set((existingOrders || []).map((o) => o.order_number));
    const newInvoices = invoicesToProcess.filter((inv) => !existingSet.has(inv.invoiceNo));

    if (newInvoices.length === 0) {
      return NextResponse.json({
        success: true,
        importedCount: 0,
        skippedCount: invoicesToProcess.length,
        message: "All invoices in this batch were already imported.",
      });
    }

    // 2. Fetch existing menu items for item_id mapping
    const { data: allMenuItems } = await supabase
      .from("menu_items")
      .select("id, name")
      .eq("tenant_id", tenantId);

    const itemNameToId = new Map<string, string>();
    for (const m of allMenuItems || []) {
      itemNameToId.set(m.name.toLowerCase().trim(), m.id);
      itemNameToId.set(cleanItemName(m.name).toLowerCase(), m.id);
    }
    const fallbackItemId = allMenuItems?.[0]?.id || null;

    // 3. Prepare Bulk Orders
    const ordersToInsert = newInvoices.map((inv) => {
      let dateObj = new Date(inv.saleDate);
      if (isNaN(dateObj.getTime())) {
        dateObj = new Date();
      }
      const isoDate = dateObj.toISOString();

      return {
        tenant_id: tenantId,
        branch_id: branchId,
        order_number: inv.invoiceNo,
        type: "DINE_IN" as const,
        status: "PAID" as const,
        channel: "STAFF",
        guest_name: inv.guestName || "Walk-in Guest",
        subtotal: Math.max(0, Number((inv.totalSales - inv.totalTax).toFixed(2))),
        tax_amount: Number(inv.totalTax.toFixed(2)),
        total_amount: Number(inv.totalSales.toFixed(2)),
        created_at: isoDate,
        billed_at: isoDate,
      };
    });

    const { data: createdOrders, error: orderErr } = await supabase
      .from("orders")
      .insert(ordersToInsert)
      .select("id, order_number, created_at");

    if (orderErr || !createdOrders) {
      return NextResponse.json({ message: orderErr?.message || "Failed to insert orders" }, { status: 500 });
    }

    const orderIdMap = new Map((createdOrders || []).map((o) => [o.order_number, o]));

    // 4. Prepare Bulk Order Items & Payments
    const orderItemsToInsert: any[] = [];
    const paymentsToInsert: any[] = [];

    for (const inv of newInvoices) {
      const createdOrder = orderIdMap.get(inv.invoiceNo);
      if (!createdOrder) continue;

      const orderId = createdOrder.id;
      const orderDate = createdOrder.created_at;

      // Map payment method
      const pType = (inv.paymentType || "UPI").toUpperCase();
      const method = pType.includes("CASH") ? "CASH" : pType.includes("CARD") ? "CARD" : "UPI";

      paymentsToInsert.push({
        tenant_id: tenantId,
        branch_id: branchId,
        order_id: orderId,
        method,
        amount: Number(inv.totalSales.toFixed(2)),
        created_at: orderDate,
      });

      if (fallbackItemId) {
        for (const it of inv.items || []) {
          const qty = Number(it.qty || 1);
          const incTax = Number(it.incTax || 0);
          const unitPrice = qty > 0 ? Number((incTax / qty).toFixed(2)) : incTax;

          const cleanedName = cleanItemName(it.itemName);
          const matchedItemId =
            itemNameToId.get(it.itemName.toLowerCase().trim()) ||
            itemNameToId.get(cleanedName.toLowerCase()) ||
            fallbackItemId;

          orderItemsToInsert.push({
            tenant_id: tenantId,
            order_id: orderId,
            menu_item_id: matchedItemId,
            name_snapshot: it.itemName || "Item",
            unit_price_snapshot: unitPrice,
            tax_rate_snapshot: 5,
            quantity: qty,
            line_total: incTax,
            status: "SERVED",
            created_at: orderDate,
          });
        }
      }
    }

    await Promise.all([
      paymentsToInsert.length > 0 ? supabase.from("payments").insert(paymentsToInsert) : Promise.resolve(),
      orderItemsToInsert.length > 0 ? supabase.from("order_items").insert(orderItemsToInsert) : Promise.resolve(),
    ]);

    return NextResponse.json({
      success: true,
      importedCount: createdOrders.length,
      skippedCount: invoicesToProcess.length - newInvoices.length,
      message: `Successfully imported ${createdOrders.length} invoices.`,
    });
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
