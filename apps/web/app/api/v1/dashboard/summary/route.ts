import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest, getAdminClient } from "@/lib/server-auth";
import { supabase } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get("branchId");

    const admin = getAdminClient();
    const client = admin ?? supabase;

    // 1. Table status counts
    let tableQuery = client
      .from("tables")
      .select("status")
      .eq("tenant_id", session.tenantId);

    if (branchId) {
      tableQuery = tableQuery.eq("branch_id", branchId);
    }

    const { data: tablesData } = await tableQuery;
    const tables = {
      available: 0,
      occupied: 0,
      reserved: 0,
      cleaning: 0,
      outOfService: 0,
    };

    (tablesData || []).forEach((t: { status: string }) => {
      switch (t.status) {
        case "AVAILABLE":
          tables.available++;
          break;
        case "OCCUPIED":
          tables.occupied++;
          break;
        case "RESERVED":
          tables.reserved++;
          break;
        case "CLEANING":
          tables.cleaning++;
          break;
        case "OUT_OF_SERVICE":
          tables.outOfService++;
          break;
      }
    });

    // 2. Orders from today (last 24 hours)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let ordersQuery = client
      .from("orders")
      .select("id, order_number, type, total_amount, status, created_at")
      .eq("tenant_id", session.tenantId)
      .gte("created_at", since)
      .order("created_at", { ascending: false });

    if (branchId) {
      ordersQuery = ordersQuery.eq("branch_id", branchId);
    }

    const { data: ordersData } = await ordersQuery.limit(50);
    const recent = ordersData || [];

    const paidOrders = recent.filter((o: any) => o.status === "PAID");
    const todayRevenue = paidOrders.reduce(
      (sum: number, o: any) => sum + Number(o.total_amount || 0),
      0,
    );

    const kitchenQueue = {
      new: 0,
      accepted: 0,
      preparing: 0,
      ready: 0,
    };

    return NextResponse.json({
      todayRevenue,
      todayOrders: recent.length,
      channels: {
        online: recent.filter((o: any) => ["QR_ORDER", "KIOSK", "DELIVERY"].includes(o.type)).length,
        offline: recent.filter((o: any) => ["DINE_IN", "TAKEAWAY"].includes(o.type)).length,
      },
      tables,
      kitchenQueue,
      recentOrders: recent.slice(0, 10).map((o: any) => ({
        id: o.id,
        orderNumber: o.order_number,
        type: o.type,
        totalAmount: String(o.total_amount || 0),
        billedAt: o.created_at,
      })),
    });
  } catch (err: any) {
    return NextResponse.json(
      { message: err?.message || "Internal server error" },
      { status: 500 },
    );
  }
}
