import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase, requireAuth } from "@/lib/server-db";

export async function GET(req: NextRequest) {
  try {
    const { session, errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");
    const stationId = searchParams.get("stationId");

    if (!branchId) {
      return NextResponse.json([]);
    }

    const supabase = getServerSupabase();
    let query = supabase
      .from("kots")
      .select(`
        id, order_id, station_id, ticket_number, status, printed_count, created_at,
        kitchen_stations(id, name),
        orders(
          order_number, type, channel, notes, guest_name,
          tables(number, name),
          customers(name, phone)
        ),
        kot_items(
          id, status,
          order_items(
            name_snapshot, quantity, kitchen_note,
            order_item_modifiers(name_snapshot)
          )
        )
      `)
      .eq("tenant_id", session!.tenantId)
      .eq("branch_id", branchId)
      .neq("status", "SERVED")
      .neq("status", "CANCELLED")
      .neq("status", "REJECTED")
      .order("created_at", { ascending: true });

    if (stationId) {
      query = query.eq("station_id", stationId);
    }

    const { data: rawKots, error } = await query;
    if (error) {
      return NextResponse.json([]);
    }

    const tickets = (rawKots || []).map((k: any) => ({
      id: k.id,
      orderId: k.order_id,
      stationId: k.station_id,
      ticketNumber: k.ticket_number,
      status: k.status,
      isPriority: false,
      printedCount: k.printed_count || 0,
      lastPrintError: null,
      createdAt: k.created_at,
      station: k.kitchen_stations ? { id: k.kitchen_stations.id, name: k.kitchen_stations.name } : null,
      order: {
        orderNumber: k.orders?.order_number || "",
        type: k.orders?.type || "DINE_IN",
        channel: k.orders?.channel || "STAFF",
        notes: k.orders?.notes || null,
        table: k.orders?.tables ? { number: String(k.orders.tables.number), name: k.orders.tables.name } : null,
        guestName: k.orders?.guest_name || null,
        customer: k.orders?.customers ? { name: k.orders.customers.name, phone: k.orders.customers.phone } : null,
      },
      items: (k.kot_items || []).map((ki: any) => ({
        id: ki.id,
        orderItem: {
          nameSnapshot: ki.order_items?.name_snapshot || "",
          quantity: ki.order_items?.quantity || 1,
          kitchenNote: ki.order_items?.kitchen_note || null,
          modifiers: (ki.order_items?.order_item_modifiers || []).map((m: any) => ({
            nameSnapshot: m.name_snapshot,
          })),
        },
      })),
    }));

    return NextResponse.json(tickets);
  } catch (err: any) {
    return NextResponse.json([]);
  }
}
