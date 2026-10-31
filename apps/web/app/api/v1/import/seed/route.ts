import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";
import { SEED_MENU_ITEMS, SEED_INVOICES } from "@/lib/seed-data";

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const supabase = getServerSupabase();

    // Check current counts for this tenant
    const { count: catCount } = await supabase
      .from("menu_categories")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", session!.tenantId);

    const { count: itemCount } = await supabase
      .from("menu_items")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", session!.tenantId);

    const { count: orderCount } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", session!.tenantId);

    return NextResponse.json({
      categoriesCount: catCount || 0,
      itemsCount: itemCount || 0,
      ordersCount: orderCount || 0,
      availableToImport: {
        menuItems: SEED_MENU_ITEMS.length,
        categories: Array.from(new Set(SEED_MENU_ITEMS.map((i) => i.category))).length,
        historicalInvoices: SEED_INVOICES.length,
      },
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

    // 1. Get Branch ID if not provided
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
      return NextResponse.json({ message: "No branch found for this restaurant" }, { status: 400 });
    }

    const tenantId = session!.tenantId;

    // 2. Ensure Categories exist
    const categoryNames = Array.from(new Set(SEED_MENU_ITEMS.map((r) => r.category)));
    const categoryMap = new Map<string, string>();

    const { data: existingCats } = await supabase
      .from("menu_categories")
      .select("id, name")
      .eq("tenant_id", tenantId);

    for (const c of existingCats || []) {
      categoryMap.set(c.name.toLowerCase().trim(), c.id);
    }

    for (let i = 0; i < categoryNames.length; i++) {
      const catName = categoryNames[i];
      const key = catName.toLowerCase().trim();
      if (!categoryMap.has(key)) {
        const { data: newCat } = await supabase
          .from("menu_categories")
          .insert({
            tenant_id: tenantId,
            branch_id: branchId,
            name: catName,
            sort_order: i,
            is_active: true,
            show_on_website: true,
          })
          .select("id")
          .single();

        if (newCat?.id) {
          categoryMap.set(key, newCat.id);
        }
      }
    }

    // 3. Upsert Menu Items
    let insertedItemsCount = 0;
    const { data: existingItems } = await supabase
      .from("menu_items")
      .select("id, name")
      .eq("tenant_id", tenantId);

    const existingItemNames = new Set((existingItems || []).map((i) => i.name.toLowerCase().trim()));

    const itemsToInsert: any[] = [];
    for (let idx = 0; idx < SEED_MENU_ITEMS.length; idx++) {
      const item = SEED_MENU_ITEMS[idx];
      const key = item.name.toLowerCase().trim();
      if (!existingItemNames.has(key)) {
        const catId = categoryMap.get(item.category.toLowerCase().trim());
        if (catId) {
          itemsToInsert.push({
            tenant_id: tenantId,
            branch_id: branchId,
            category_id: catId,
            name: item.name,
            price: item.price,
            cost_price: item.costPrice,
            prep_time_minutes: item.prepTime,
            is_veg: item.isVeg,
            image_url: item.image,
            sort_order: idx,
            is_active: true,
            tax_rate_percent: 5,
          });
        }
      }
    }

    if (itemsToInsert.length > 0) {
      const { data: inserted, error: itemErr } = await supabase
        .from("menu_items")
        .insert(itemsToInsert)
        .select("id");

      if (!itemErr) {
        insertedItemsCount = inserted?.length || 0;
      }
    }

    // 4. Ensure Starter Floor & Tables
    const { count: floorCount } = await supabase
      .from("floors")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("branch_id", branchId);

    if (!floorCount || floorCount === 0) {
      const { data: newFloor } = await supabase
        .from("floors")
        .insert({
          tenant_id: tenantId,
          branch_id: branchId,
          name: "Main Dining",
          sort_order: 0,
        })
        .select("id")
        .single();

      if (newFloor) {
        const tables = [1, 2, 3, 4, 5, 6, 7, 8].map((num, i) => ({
          tenant_id: tenantId,
          branch_id: branchId,
          floor_id: newFloor.id,
          number: String(num),
          name: `Table ${num}`,
          capacity: num <= 2 ? 2 : num <= 6 ? 4 : 6,
          pos_x: 40 + (i % 4) * 140,
          pos_y: 40 + Math.floor(i / 4) * 140,
          width: num > 6 ? 120 : 80,
          height: 80,
          shape: num > 6 ? "rect" : "square",
          status: "AVAILABLE",
        }));
        await supabase.from("tables").insert(tables);
      }
    }

    // 5. Import Recent Historical Sales (Up to 100 recent distinct invoices)
    let importedOrdersCount = 0;
    const { data: existingOrders } = await supabase
      .from("orders")
      .select("order_number")
      .eq("tenant_id", tenantId)
      .limit(1000);

    const existingInvSet = new Set((existingOrders || []).map((o) => o.order_number));

    const { data: allMenuItems } = await supabase
      .from("menu_items")
      .select("id, name")
      .eq("tenant_id", tenantId);

    const itemNameToId = new Map(
      (allMenuItems || []).map((m) => [m.name.toLowerCase().trim(), m.id]),
    );
    const fallbackItemId = allMenuItems?.[0]?.id || null;

    const invoicesToImport = SEED_INVOICES
      .filter((inv) => !existingInvSet.has(inv.invoiceNo))
      .slice(0, 100);

    for (const inv of invoicesToImport) {
      let dateObj = new Date(inv.saleDate);
      if (isNaN(dateObj.getTime())) {
        dateObj = new Date();
      }
      const isoDate = dateObj.toISOString();

      const method = inv.paymentType.toUpperCase().includes("CASH")
        ? "CASH"
        : inv.paymentType.toUpperCase().includes("CARD")
          ? "CARD"
          : "UPI";

      const { data: createdOrder } = await supabase
        .from("orders")
        .insert({
          tenant_id: tenantId,
          branch_id: branchId,
          order_number: inv.invoiceNo,
          type: "DINE_IN",
          status: "PAID",
          channel: "STAFF",
          guest_name: inv.guestName,
          subtotal: Math.max(0, inv.totalSales - inv.totalTax),
          tax_amount: inv.totalTax,
          total_amount: inv.totalSales,
          created_at: isoDate,
          billed_at: isoDate,
        })
        .select("id")
        .single();

      if (createdOrder?.id) {
        importedOrdersCount++;

        // Insert order items
        if (fallbackItemId) {
          const itemsRows = inv.items.map((it) => ({
            tenant_id: tenantId,
            order_id: createdOrder.id,
            menu_item_id: itemNameToId.get(it.itemName.toLowerCase().trim()) || fallbackItemId,
            name_snapshot: it.itemName,
            unit_price_snapshot: it.incTax / (it.qty || 1),
            tax_rate_snapshot: 5,
            quantity: it.qty,
            line_total: it.incTax,
            status: "SERVED",
            created_at: isoDate,
          }));
          await supabase.from("order_items").insert(itemsRows);
        }

        // Insert payment
        await supabase.from("payments").insert({
          tenant_id: tenantId,
          branch_id: branchId,
          order_id: createdOrder.id,
          method,
          amount: inv.totalSales,
          created_at: isoDate,
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: "Data import completed successfully!",
      imported: {
        categories: categoryMap.size,
        menuItems: insertedItemsCount,
        orders: importedOrdersCount,
      },
    });
  } catch (err: any) {
    console.error("Seed error:", err);
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
