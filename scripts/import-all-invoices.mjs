#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

/**
 * Standalone CLI Script to import all past invoices from CSV into Supabase.
 * Usage:
 *   SUPABASE_URL=https://xyz.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-all-invoices.mjs [path-to-csv]
 */

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
  console.error("Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-all-invoices.mjs [path/to/invoices.csv]");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

const defaultCsv = "/Users/kumaramiya/.gemini/antigravity/brain/c7a1e045-c5e4-4a65-b3cc-9ec57c6ec171/.user_uploaded/media_1793449757151_56e051cb.csv";
const csvPath = process.argv[2] || defaultCsv;

if (!fs.existsSync(csvPath)) {
  console.error(`❌ CSV file not found at: ${csvPath}`);
  process.exit(1);
}

function parseCsvLine(line) {
  const parts = [];
  let cur = "";
  let inQuote = false;
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    if (c === '"') {
      inQuote = !inQuote;
    } else if (c === "," && !inQuote) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur.trim());
  return parts;
}

async function run() {
  console.log(`📂 Reading invoices from: ${csvPath}`);
  const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");

  const invoicesMap = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const parts = parseCsvLine(lines[i]);
    const [
      saleDate, invoiceNo, guestName, itemName, category, qty,
      salesExcTax, tax, salesIncTax, discount, collected, due, paymentType, status
    ] = parts;

    if (!invoiceNo) continue;
    const invKey = invoiceNo.replace(/^"|"$/g, "");
    if (!invoicesMap.has(invKey)) {
      invoicesMap.set(invKey, {
        saleDate: (saleDate || "").replace(/^"|"$/g, ""),
        invoiceNo: invKey,
        guestName: (guestName || "Walk-in Guest").replace(/^"|"$/g, ""),
        paymentType: (paymentType || "UPI").replace(/^"|"$/g, ""),
        totalSales: 0,
        totalTax: 0,
        items: [],
      });
    }

    const inv = invoicesMap.get(invKey);
    const incTax = parseFloat(salesIncTax) || 0;
    const taxVal = parseFloat(tax) || 0;
    inv.totalSales += incTax;
    inv.totalTax += taxVal;
    inv.items.push({
      itemName: (itemName || "Item").replace(/^"|"$/g, ""),
      qty: parseInt(qty) || 1,
      incTax,
    });
  }

  const allInvoices = Array.from(invoicesMap.values());
  console.log(`📊 Found ${allInvoices.length} unique invoices across ${lines.length - 1} rows.`);

  // 1. Get primary tenant and branch
  const { data: tenants, error: tenantErr } = await supabase
    .from("tenants")
    .select("id, name")
    .limit(1);

  if (tenantErr || !tenants || tenants.length === 0) {
    console.error("❌ No tenant found in database:", tenantErr?.message);
    process.exit(1);
  }

  const tenantId = tenants[0].id;
  console.log(`🏢 Restaurant Tenant: "${tenants[0].name}" (${tenantId})`);

  const { data: branches } = await supabase
    .from("branches")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .limit(1);

  const branchId = branches?.[0]?.id;
  if (!branchId) {
    console.error("❌ No branch found for tenant");
    process.exit(1);
  }
  console.log(`📍 Branch: "${branches[0].name}" (${branchId})`);

  // 2. Fetch existing menu items for reference
  const { data: menuItems } = await supabase
    .from("menu_items")
    .select("id, name")
    .eq("tenant_id", tenantId);

  const itemMap = new Map((menuItems || []).map((m) => [m.name.toLowerCase().trim(), m.id]));
  const fallbackItemId = menuItems?.[0]?.id || null;

  // 3. Batch insert in chunks of 150
  const batchSize = 150;
  let totalImported = 0;

  for (let i = 0; i < allInvoices.length; i += batchSize) {
    const chunk = allInvoices.slice(i, i + batchSize);
    const chunkNumbers = chunk.map((c) => c.invoiceNo);

    // Skip already imported
    const { data: existing } = await supabase
      .from("orders")
      .select("order_number")
      .eq("tenant_id", tenantId)
      .eq("branch_id", branchId)
      .in("order_number", chunkNumbers);

    const existingSet = new Set((existing || []).map((e) => e.order_number));
    const newChunk = chunk.filter((c) => !existingSet.has(c.invoiceNo));

    if (newChunk.length === 0) {
      console.log(`⏩ Batch ${Math.floor(i / batchSize) + 1}: All ${chunk.length} invoices already exist, skipping.`);
      continue;
    }

    const ordersToInsert = newChunk.map((inv) => {
      let d = new Date(inv.saleDate);
      if (isNaN(d.getTime())) d = new Date();
      const iso = d.toISOString();
      return {
        tenant_id: tenantId,
        branch_id: branchId,
        order_number: inv.invoiceNo,
        type: "DINE_IN",
        status: "PAID",
        channel: "STAFF",
        guest_name: inv.guestName,
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
      console.error(`❌ Batch error:`, insertErr?.message);
      continue;
    }

    const orderIdMap = new Map(createdOrders.map((o) => [o.order_number, o]));
    const itemsToInsert = [];
    const paymentsToInsert = [];

    for (const inv of newChunk) {
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
          const qty = it.qty || 1;
          const incTax = it.incTax || 0;
          itemsToInsert.push({
            tenant_id: tenantId,
            order_id: ord.id,
            menu_item_id: itemMap.get(it.itemName.toLowerCase().trim()) || fallbackItemId,
            name_snapshot: it.itemName,
            unit_price_snapshot: Number((incTax / qty).toFixed(2)),
            tax_rate_snapshot: 5,
            quantity: qty,
            line_total: incTax,
            status: "SERVED",
            created_at: ord.created_at,
          });
        }
      }
    }

    await Promise.all([
      itemsToInsert.length > 0 ? supabase.from("order_items").insert(itemsToInsert) : Promise.resolve(),
      paymentsToInsert.length > 0 ? supabase.from("payments").insert(paymentsToInsert) : Promise.resolve(),
    ]);

    totalImported += createdOrders.length;
    const pct = Math.round(((i + chunk.length) / allInvoices.length) * 100);
    console.log(`✅ Progress: ${pct}% — Imported ${createdOrders.length} invoices (Total new: ${totalImported})`);
  }

  console.log(`\n🎉 Import Complete! Successfully imported ${totalImported} invoices into Supabase.`);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
