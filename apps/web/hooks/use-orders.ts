"use client";

import type {
  AddOrderItemsDto,
  CheckoutDto,
  CreateOrderDto,
  KotStatusDto,
  RefundDto,
  UpdateOrderDto,
} from "@nodedr-restaurant/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Customer } from "@/hooks/use-customers";
import { api } from "@/lib/api";

export interface CreatedOrder {
  id: string;
  orderNumber: string;
  subtotal: string;
  taxAmount: string;
  discountAmount: string;
  tipAmount: string;
  loyaltyPointsRedeemed: number;
  loyaltyDiscountAmount: string;
  totalAmount: string;
  deliveryFee?: string;
  status: string;
  payments?: { method: string; amount: string; tendered?: string | null; changeGiven?: string | null }[];
}

/** What a checkout call answers with: the order plus where its settlement stands. */
export interface CheckoutResult extends CreatedOrder {
  settlement: {
    amountDue: number;
    amountPaid: number;
    balanceDue: number;
    changeDue: number;
    fullyPaid: boolean;
  };
}

import { supabase } from "@/lib/supabase";

export function useCreateOrder(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (dto: CreateOrderDto) => {
      // 1. Direct Supabase Atomic RPC Call (Zero Vercel invocation, 1 DB round-trip)
      try {
        const { data, error } = await supabase.rpc("create_pos_order", {
          p_branch_id: branchId,
          p_type: dto.type ?? "DINE_IN",
          p_table_id: dto.tableId ?? null,
          p_guest_count: dto.guestCount ?? null,
          p_guest_name: dto.guestName ?? null,
          p_customer_id: dto.customerId ?? null,
          p_notes: dto.notes ?? null,
          p_items: dto.items.map((i) => ({
            menu_item_id: i.menuItemId,
            quantity: i.quantity,
            kitchen_note: i.kitchenNote ?? null,
            modifier_ids: i.modifierIds ?? [],
          })),
          p_auto_occupy_table: true,
          p_deduct_inventory: false,
        });

        if (!error && data) {
          const res = data as { order_id: string; order_number: string; total_amount: number; status: string };
          return {
            id: res.order_id,
            orderNumber: res.order_number,
            totalAmount: String(res.total_amount),
            subtotal: String(res.total_amount),
            taxAmount: "0",
            discountAmount: "0",
            tipAmount: "0",
            loyaltyPointsRedeemed: 0,
            loyaltyDiscountAmount: "0",
            status: res.status,
          } as CreatedOrder;
        }
      } catch (err) {
        console.warn("Direct RPC failed, falling back to REST endpoint:", err);
      }

      // Fallback to REST endpoint
      return api.post<CreatedOrder>(`/orders?branchId=${branchId}`, dto);
    },
    onSuccess: (newOrder) => {
      // Patch table status in floor plan cache directly without refetch
      queryClient.setQueriesData({ queryKey: ["orders", "open", branchId] }, (old: any) => {
        if (!old || !Array.isArray(old)) return [newOrder];
        if (old.some((o) => o.id === newOrder.id)) return old;
        return [newOrder, ...old];
      });
    },
  });
}

/** The bill as the server prices it right now; never saves anything. */
export interface BillPreview {
  locked: boolean;
  status: string;
  subtotal: number;
  discountAmount: number;
  discountPercent: number;
  discountType: "PERCENT" | "FIXED" | null;
  discountValue: number | null;
  couponCode: string | null;
  promotionName: string | null;
  taxAmount: number;
  loyaltyPointsRedeemed: number;
  loyaltyDiscountAmount: number;
  tipAmount: number;
  deliveryFee: number;
  totalDue: number;
  amountPaid: number;
  balanceDue: number;
}

export type BillAdjustments = Pick<
  CheckoutDto,
  "discountPercent" | "tipAmount" | "loyaltyPointsToRedeem" | "couponCode" | "customerId"
>;

export function useBillPreview(branchId: string | null, orderId: string, adj: BillAdjustments, enabled = true) {
  // `customerId` only matters at checkout; the server prices from the order.
  const { customerId: _customerId, ...priced } = adj;
  void _customerId;
  return useQuery({
    queryKey: ["orders", "bill", branchId, orderId, priced],
    queryFn: () => api.post<BillPreview>(`/orders/${orderId}/bill-preview?branchId=${branchId}`, priced),
    enabled: !!branchId && enabled,
    retry: false,
    // Keep the last figures on screen while a changed discount is repriced.
    placeholderData: (previous) => previous,
  });
}

export function useCheckoutOrder(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, dto }: { orderId: string; dto: CheckoutDto }) => {
      try {
        const paymentMethod = dto.payments?.[0]?.method ?? "CASH";
        const totalPaid = dto.payments?.reduce((acc, p) => acc + Number(p.amount || 0), 0) ?? 0;

        const { data, error } = await supabase.rpc("settle_pos_order", {
          p_order_id: orderId,
          p_payment_method: paymentMethod,
          p_amount: totalPaid,
          p_tendered: dto.payments?.[0]?.tendered ? Number(dto.payments[0].tendered) : null,
          p_change_given: (dto.payments?.[0] as any)?.changeGiven ? Number((dto.payments?.[0] as any).changeGiven) : null,
          p_reference: dto.payments?.[0]?.reference ?? null,
        });

        if (!error && data) {
          return {
            id: orderId,
            orderNumber: "",
            status: "PAID",
            subtotal: "0",
            taxAmount: "0",
            discountAmount: "0",
            tipAmount: "0",
            loyaltyPointsRedeemed: 0,
            loyaltyDiscountAmount: "0",
            totalAmount: String(totalPaid),
            settlement: {
              amountDue: 0,
              amountPaid: totalPaid,
              balanceDue: 0,
              changeDue: 0,
              fullyPaid: true,
            },
          } as CheckoutResult;
        }
      } catch (err) {
        console.warn("Direct RPC checkout failed, falling back to REST:", err);
      }

      return api.post<CheckoutResult>(`/orders/${orderId}/checkout?branchId=${branchId}`, dto);
    },
    onSuccess: (_, { orderId }) => {
      // Direct in-memory state patch: Remove order from open orders list without refetch
      queryClient.setQueriesData({ queryKey: ["orders", "open", branchId] }, (old: any) => {
        if (!old || !Array.isArray(old)) return old;
        return old.filter((o) => o.id !== orderId);
      });
    },
  });
}

export interface OpenOrder {
  id: string;
  orderNumber: string;
  type: string;
  tableId: string | null;
  subtotal: string;
  taxAmount: string;
  discountAmount: string;
  tipAmount: string;
  loyaltyPointsRedeemed: number;
  loyaltyDiscountAmount: string;
  totalAmount: string;
  status: string;
  customer: Customer | null;
}

export type OrderChannel = "STAFF" | "ONLINE";
export type AcceptanceStatus = "NOT_REQUIRED" | "PENDING" | "ACCEPTED" | "REJECTED";

// Shape of GET /orders/:id (the order row with its relations).
export interface OrderDetail {
  id: string;
  orderNumber: string;
  type: string;
  status: string;
  channel: OrderChannel;
  acceptance: AcceptanceStatus;
  tableId: string | null;
  guestName: string | null;
  guestCount: number | null;
  notes: string | null;
  cancelReason: string | null;
  subtotal: string;
  taxAmount: string;
  discountAmount: string;
  tipAmount: string;
  totalAmount: string;
  createdAt: string;
  billedAt: string | null;
  table: { id: string; name: string | null; number: string } | null;
  customer: Customer | null;
  items: {
    id: string;
    menuItemId: string;
    nameSnapshot: string;
    quantity: number;
    unitPriceSnapshot: string;
    lineTotal: string;
    kitchenNote: string | null;
    modifiers: { id: string; nameSnapshot: string; priceAdjSnapshot: string }[];
  }[];
  kots: {
    id: string;
    status: KotStatusDto;
    printedCount: number;
    rejectReason: string | null;
    items: { orderItemId: string; status: string }[];
  }[];
  cancelSource: "STAFF" | "CUSTOMER" | "KITCHEN_REJECTED" | "ONLINE_DECLINED" | null;
  discountType: "PERCENT" | "FIXED" | null;
  discountValue: string | null;
  loyaltyPointsRedeemed: number;
  loyaltyDiscountAmount: string;
  deliveryFee?: string;
  payments: {
    id: string;
    method: string;
    amount: string;
    tendered: string | null;
    changeGiven: string | null;
    createdAt: string;
  }[];
}

export function useOrder(branchId: string | null, orderId: string | null) {
  return useQuery({
    queryKey: ["orders", "detail", branchId, orderId],
    queryFn: () => api.get<OrderDetail>(`/orders/${orderId}?branchId=${branchId}`),
    enabled: !!branchId && !!orderId,
  });
}

export interface ManagedOrder {
  id: string;
  orderNumber: string;
  type: string;
  status: string;
  channel: OrderChannel;
  acceptance: AcceptanceStatus;
  guestName: string | null;
  totalAmount: string;
  createdAt: string;
  table: { id: string; name: string | null; number: number } | null;
  customer: Customer | null;
  items: { id: string; nameSnapshot: string; quantity: number }[];
}

export type OrderTab = "pending" | "active" | "history";

export function useManagedOrders(
  branchId: string | null,
  tab: OrderTab,
  channel?: OrderChannel,
  type?: string,
) {
  return useQuery({
    queryKey: ["orders", "manage", branchId, tab, channel ?? "", type ?? ""],
    queryFn: () => {
      const q = new URLSearchParams({ branchId: branchId ?? "", tab });
      if (channel) q.set("channel", channel);
      if (type) q.set("type", type);
      return api.get<ManagedOrder[]>(`/orders/manage?${q.toString()}`);
    },
    enabled: !!branchId,
    refetchInterval: 10_000,
  });
}

export function useAcceptOrder(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => api.post(`/orders/${orderId}/accept?branchId=${branchId}`),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["kds", "tickets", branchId] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useRejectOrder(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, reason }: { orderId: string; reason: string }) =>
      api.post(`/orders/${orderId}/reject?branchId=${branchId}`, { reason }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["kds"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useOpenOrders(branchId: string | null) {
  return useQuery({
    queryKey: ["orders", "open", branchId],
    queryFn: async () => {
      if (!branchId) return [];

      // Egress Optimization: Query Supabase directly with strict column selection and 24h bounding
      try {
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase
          .from("orders")
          .select("id, order_number, type, table_id, subtotal, tax_amount, discount_amount, total_amount, status")
          .eq("branch_id", branchId)
          .in("status", ["OPEN", "BILLED"])
          .gte("created_at", since24h)
          .order("created_at", { ascending: false });

        if (!error && data) {
          return data.map((o) => ({
            id: o.id,
            orderNumber: o.order_number,
            type: o.type,
            tableId: o.table_id,
            subtotal: String(o.subtotal),
            taxAmount: String(o.tax_amount),
            discountAmount: String(o.discount_amount),
            tipAmount: "0",
            loyaltyPointsRedeemed: 0,
            loyaltyDiscountAmount: "0",
            totalAmount: String(o.total_amount),
            status: o.status,
            customer: null,
          })) as OpenOrder[];
        }
      } catch (err) {
        console.warn("Direct Supabase query failed, falling back to REST API:", err);
      }

      return api.get<OpenOrder[]>(`/orders?branchId=${branchId}`);
    },
    enabled: !!branchId,
    // Realtime postgres_changes handles live state updates; turn off aggressive polling to save egress
    refetchInterval: false,
    staleTime: 1000 * 60 * 5, // 5 min
  });
}

export function useOpenOrdersForTable(branchId: string | null, tableId: string | null) {
  return useQuery({
    queryKey: ["orders", "open", branchId, "table", tableId],
    queryFn: () => api.get<OpenOrder[]>(`/orders?branchId=${branchId}&tableId=${tableId}`),
    enabled: !!branchId && !!tableId,
    // A table's bills change from other terminals; never trust a cached list.
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useAddOrderItems(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, dto }: { orderId: string; dto: AddOrderItemsDto }) =>
      api.post<CreatedOrder>(`/orders/${orderId}/items?branchId=${branchId}`, dto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["floors", branchId] });
    },
  });
}

export function useMergeOrder(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ targetOrderId, sourceOrderId }: { targetOrderId: string; sourceOrderId: string }) =>
      api.post(`/orders/${targetOrderId}/merge?branchId=${branchId}`, { sourceOrderId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["floors", branchId] });
      queryClient.invalidateQueries({ queryKey: ["orders", "open", branchId] });
    },
  });
}

// Everything a changed bill can touch on screen: lists, the table map, the
// kitchen screen, dashboard figures.
function invalidateBillViews(queryClient: ReturnType<typeof useQueryClient>, branchId: string | null) {
  queryClient.invalidateQueries({ queryKey: ["orders"] });
  queryClient.invalidateQueries({ queryKey: ["floors", branchId] });
  queryClient.invalidateQueries({ queryKey: ["kds"] });
  queryClient.invalidateQueries({ queryKey: ["dashboard"] });
}

export function useCancelOrder(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      orderId,
      reason,
      source,
      confirmStarted,
    }: {
      orderId: string;
      reason: string;
      source?: "STAFF" | "CUSTOMER";
      confirmStarted?: boolean;
    }) => api.post<CreatedOrder>(`/orders/${orderId}/cancel?branchId=${branchId}`, { reason, source, confirmStarted }),
    onSuccess: () => invalidateBillViews(queryClient, branchId),
  });
}

export function useUpdateOrder(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, dto }: { orderId: string; dto: UpdateOrderDto }) =>
      api.patch<OrderDetail>(`/orders/${orderId}?branchId=${branchId}`, dto),
    onSuccess: () => invalidateBillViews(queryClient, branchId),
  });
}

export function useUpdateOrderItem(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, itemId, quantity }: { orderId: string; itemId: string; quantity: number }) =>
      api.patch<OrderDetail>(`/orders/${orderId}/items/${itemId}?branchId=${branchId}`, { quantity }),
    onSuccess: () => invalidateBillViews(queryClient, branchId),
  });
}

export function useRemoveOrderItem(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, itemId, reason }: { orderId: string; itemId: string; reason: string }) =>
      api.post<OrderDetail>(`/orders/${orderId}/items/${itemId}/remove?branchId=${branchId}`, { reason }),
    onSuccess: () => invalidateBillViews(queryClient, branchId),
  });
}

export function useRefundOrder(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, dto }: { orderId: string; dto: RefundDto }) =>
      api.post(`/orders/${orderId}/refund?branchId=${branchId}`, dto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard", "summary", branchId] }),
  });
}

export function useDeleteOrders(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: { orderIds: string[]; password: string }) =>
      api.post<{ deleted: number }>(`/orders/delete-bulk?branchId=${branchId}`, dto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
  });
}
