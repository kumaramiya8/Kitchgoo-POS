import { SupabaseClient } from "@supabase/supabase-js";
import { SEED_MENU_ITEMS } from "@/lib/seed-data";
import allInvoicesData from "@/lib/all-invoices.json";

export interface InvoiceRecord {
  saleDate: string;
  invoiceNo: string;
  guestName: string;
  paymentType: string;
  totalSales: number;
  totalTax: number;
  items: { itemName: string; qty: number; incTax: number }[];
}

/**
 * Normalizes item names to handle minor trailing dots or numeric suffixes in historical sales
 * (e.g., "Veg manchow soup.100" -> "Veg Manchow Soup")
 */
function cleanItemName(name: string): string {
  let cleaned = name.trim();
  cleaned = cleaned.replace(/\.\d+$/, ""); // remove trailing ".100"
  cleaned = cleaned.replace(/\.+$/, "");   // remove trailing "."
  return cleaned.trim();
}

/**
 * Ensures categories, menu items, starter tables, and all 2,008 historical invoices
 * are seeded in Supabase for the given tenant and branch.
 */
export async function ensureSeeded(
  supabase: SupabaseClient,
  tenantId: string,
  providedBranchId?: string | null,
  forceSeedInvoices = false,
) {
  // 1. Resolve branch ID
  let branchId = providedBranchId;
  if (!branchId) {
    const { data: firstBranch } = await supabase
      .from("branches")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();
    branchId = firstBranch?.id ?? null;
  }

  if (!branchId) {
    return { success: false, message: "No active branch found for tenant" };
  }

  // 2. Ensure Categories Exist
  const categoryNames = Array.from(new Set(SEED_MENU_ITEMS.map((r) => r.category)));
  const categoryMap = new Map<string, string>();

  const { data: existingCats } = await supabase
    .from("menu_categories")
    .select("id, name")
    .eq("tenant_id", tenantId);

  for (const c of existingCats || []) {
    categoryMap.set(c.name.toLowerCase().trim(), c.id);
  }

  const missingCategories = categoryNames.filter((cat) => !categoryMap.has(cat.toLowerCase().trim()));
  if (missingCategories.length > 0) {
    const catsToInsert = missingCategories.map((catName, i) => ({
      tenant_id: tenantId,
      branch_id: branchId,
      name: catName,
      sort_order: i,
      is_active: true,
      show_on_website: true,
    }));

    const { data: insertedCats } = await supabase
      .from("menu_categories")
      .insert(catsToInsert)
      .select("id, name");

    for (const c of insertedCats || []) {
      categoryMap.set(c.name.toLowerCase().trim(), c.id);
    }
  }

  // 3. Ensure Menu Items Exist
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
    await supabase.from("menu_items").insert(itemsToInsert);
  }

  // Re-fetch all menu items to build the ID lookup map
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

  // 4. Ensure Floor and Tables Exist
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

  // 5. Check if Historical Orders Exist
  const { count: orderCount } = await supabase
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("branch_id", branchId);

  const currentOrderCount = orderCount || 0;
  if (!forceSeedInvoices && currentOrderCount > 0) {
    return {
      success: true,
      alreadySeeded: true,
      ordersCount: currentOrderCount,
      menuItemsCount: (allMenuItems || []).length,
    };
  }

  // 6. Bulk Seed all 2,008 Historical Invoices in batches of 500
  const allInvoices = allInvoicesData as InvoiceRecord[];
  let totalImportedOrders = 0;
  const batchSize = 500;

  for (let offset = 0; offset < allInvoices.length; offset += batchSize) {
    const chunk = allInvoices.slice(offset, offset + batchSize);
    const chunkNumbers = chunk.map((c) => c.invoiceNo);

    // Filter out any already existing in this chunk
    const { data: existingInChunk } = await supabase
      .from("orders")
      .select("order_number")
      .eq("tenant_id", tenantId)
      .eq("branch_id", branchId)
      .in("order_number", chunkNumbers);

    const existingChunkSet = new Set((existingInChunk || []).map((e) => e.order_number));
    const newInChunk = chunk.filter((c) => !existingChunkSet.has(c.invoiceNo));

    if (newInChunk.length === 0) continue;

    // Prepare orders
    const ordersToInsert = newInChunk.map((inv) => {
      let dateObj = new Date(inv.saleDate);
      if (isNaN(dateObj.getTime())) dateObj = new Date();
      const iso = dateObj.toISOString();

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
        created_at: iso,
        billed_at: iso,
      };
    });

    const { data: createdOrders, error: insertErr } = await supabase
      .from("orders")
      .insert(ordersToInsert)
      .select("id, order_number, created_at");

    if (insertErr || !createdOrders) {
      console.error("Error bulk inserting order batch:", insertErr?.message);
      continue;
    }

    const orderIdMap = new Map(createdOrders.map((o) => [o.order_number, o]));
    const itemsToInsert: any[] = [];
    const paymentsToInsert: any[] = [];

    for (const inv of newInChunk) {
      const ord = orderIdMap.get(inv.invoiceNo);
      if (!ord) continue;

      const pType = (inv.paymentType || "UPI").toUpperCase();
      const method = pType.includes("CASH") ? "CASH" : pType.includes("CARD") ? "CARD" : "UPI";

      paymentsToInsert.push({
        tenant_id: tenantId,
        branch_id: branchId,
        order_id: ord.id,
        method,
        amount: Number(inv.totalSales.toFixed(2)),
        created_at: ord.created_at,
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

          itemsToInsert.push({
            tenant_id: tenantId,
            order_id: ord.id,
            menu_item_id: matchedItemId,
            name_snapshot: it.itemName,
            unit_price_snapshot: unitPrice,
            tax_rate_snapshot: 5,
            quantity: qty,
            line_total: incTax,
            status: "SERVED",
            created_at: ord.created_at,
          });
        }
      }
    }

    // Insert payments and order items in parallel
    await Promise.all([
      paymentsToInsert.length > 0 ? supabase.from("payments").insert(paymentsToInsert) : Promise.resolve(),
      itemsToInsert.length > 0 ? supabase.from("order_items").insert(itemsToInsert) : Promise.resolve(),
    ]);

    totalImportedOrders += createdOrders.length;
  }

  return {
    success: true,
    seeded: true,
    importedOrders: totalImportedOrders,
    menuItemsCount: (allMenuItems || []).length,
  };
}
