import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-db";

export const REPORT_CATALOG = [
  { key: "sales-daily", title: "Daily sales", group: "Sales" },
  { key: "sales-by-item", title: "Sales by item", group: "Sales" },
  { key: "sales-by-category", title: "Sales by category", group: "Sales" },
  { key: "popular-items", title: "Popular items", group: "Sales" },
  { key: "slow-movers", title: "Slow movers", group: "Sales" },
  { key: "payment-methods", title: "Payment methods", group: "Sales" },
  { key: "discounts", title: "Discounts & coupons", group: "Sales" },
  { key: "tax", title: "Tax (GST) summary", group: "Tax" },
  { key: "peak-hours", title: "Peak hours", group: "Analytics" },
  { key: "customers", title: "Top customers", group: "Customers" },
];

export async function GET(req: NextRequest) {
  try {
    const { errorResponse } = requireAuth(req);
    if (errorResponse) return errorResponse;

    return NextResponse.json(REPORT_CATALOG);
  } catch (err: any) {
    return NextResponse.json({ message: err?.message || "Internal server error" }, { status: 500 });
  }
}
