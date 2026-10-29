"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { setRealtimeState } from "@/lib/realtime-status";

interface OrderRealtimePayload {
  id: string;
  orderNumber: string;
  type: string;
  status: string;
  tableId: string | null;
  totalAmount: string;
  subtotal: string;
  taxAmount: string;
  discountAmount: string;
  guestName: string | null;
  [key: string]: unknown;
}

interface TableRealtimePayload {
  id: string;
  number: string;
  status: string;
  statusSince: string;
  assignedWaiterId: string | null;
  [key: string]: unknown;
}

interface KotRealtimePayload {
  id: string;
  orderId: string;
  ticketNumber: string;
  status: string;
  printedCount: number;
  [key: string]: unknown;
}

/**
 * Ultra-low egress Supabase Realtime subscription.
 * Replaces Socket.IO with scoped Postgres Changes & Broadcasts.
 * Directly patches the TanStack Query cache in-memory to prevent full-table refetches.
 */
export function useRealtime(branchId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!branchId) return;

    setRealtimeState("connecting");

    const channelName = `realtime:branch:${branchId}`;
    const channel = supabase.channel(channelName);

    // 1. ORDERS TABLE CHANGES (ZERO REFETCH STATE PATCHING)
    channel
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orders",
          filter: `branch_id=eq.${branchId}`,
        },
        (payload) => {
          const eventType = payload.eventType; // 'INSERT' | 'UPDATE' | 'DELETE'
          const newOrder = payload.new as OrderRealtimePayload;
          const oldOrder = payload.old as Partial<OrderRealtimePayload>;

          if (eventType === "INSERT") {
            // Prepend new order to open orders cache
            queryClient.setQueriesData(
              { queryKey: ["orders", "open", branchId] },
              (existing: OrderRealtimePayload[] | undefined) => {
                if (!existing || !Array.isArray(existing)) return [newOrder];
                if (existing.some((o) => o.id === newOrder.id)) return existing;
                return [newOrder, ...existing];
              },
            );

            // Prepend to managed orders cache
            queryClient.setQueriesData(
              { queryKey: ["orders", "manage", branchId] },
              (existing: OrderRealtimePayload[] | undefined) => {
                if (!existing || !Array.isArray(existing)) return [newOrder];
                if (existing.some((o) => o.id === newOrder.id)) return existing;
                return [newOrder, ...existing];
              },
            );
          } else if (eventType === "UPDATE") {
            // In-place patch for open orders
            queryClient.setQueriesData(
              { queryKey: ["orders", "open", branchId] },
              (existing: OrderRealtimePayload[] | undefined) => {
                if (!existing || !Array.isArray(existing)) return existing;
                // If order is now PAID or CANCELLED, remove from open orders
                if (newOrder.status === "PAID" || newOrder.status === "CANCELLED") {
                  return existing.filter((o) => o.id !== newOrder.id);
                }
                return existing.map((o) => (o.id === newOrder.id ? { ...o, ...newOrder } : o));
              },
            );

            // In-place patch for managed orders
            queryClient.setQueriesData(
              { queryKey: ["orders", "manage", branchId] },
              (existing: OrderRealtimePayload[] | undefined) => {
                if (!existing || !Array.isArray(existing)) return existing;
                return existing.map((o) => (o.id === newOrder.id ? { ...o, ...newOrder } : o));
              },
            );

            // In-place patch for order detail view
            queryClient.setQueryData(
              ["orders", "detail", branchId, newOrder.id],
              (existing: OrderRealtimePayload | undefined) => {
                if (!existing) return existing;
                return { ...existing, ...newOrder };
              },
            );
          } else if (eventType === "DELETE") {
            // Remove from open orders
            queryClient.setQueriesData(
              { queryKey: ["orders", "open", branchId] },
              (existing: OrderRealtimePayload[] | undefined) => {
                if (!existing || !Array.isArray(existing)) return existing;
                return existing.filter((o) => o.id !== oldOrder.id);
              },
            );
          }
        },
      )
      // 2. TABLES STATUS CHANGES (FLOOR PLAN LIVE UPDATE)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "tables",
          filter: `branch_id=eq.${branchId}`,
        },
        (payload) => {
          const updatedTable = payload.new as TableRealtimePayload;

          // Directly patch table status inside floor layout cache
          queryClient.setQueriesData(
            { queryKey: ["floors", branchId] },
            (existingFloors: unknown) => {
              if (!existingFloors || !Array.isArray(existingFloors)) return existingFloors;
              return existingFloors.map((floor: { tables?: TableRealtimePayload[] }) => {
                if (!floor.tables || !Array.isArray(floor.tables)) return floor;
                return {
                  ...floor,
                  tables: floor.tables.map((t) =>
                    t.id === updatedTable.id ? { ...t, ...updatedTable } : t,
                  ),
                };
              });
            },
          );
        },
      )
      // 3. KITCHEN ORDER TICKETS (KDS ZERO-REFETCH PATCHING)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "kots",
          filter: `branch_id=eq.${branchId}`,
        },
        (payload) => {
          const eventType = payload.eventType;
          const newKot = payload.new as KotRealtimePayload;

          queryClient.setQueriesData(
            { queryKey: ["kds", "tickets", branchId] },
            (existingKots: KotRealtimePayload[] | undefined) => {
              if (!existingKots || !Array.isArray(existingKots)) {
                return eventType === "INSERT" ? [newKot] : existingKots;
              }

              if (eventType === "INSERT") {
                if (existingKots.some((k) => k.id === newKot.id)) return existingKots;
                return [newKot, ...existingKots];
              }

              if (eventType === "UPDATE") {
                if (newKot.status === "SERVED" || newKot.status === "CANCELLED") {
                  return existingKots.filter((k) => k.id !== newKot.id);
                }
                return existingKots.map((k) => (k.id === newKot.id ? { ...k, ...newKot } : k));
              }

              if (eventType === "DELETE") {
                return existingKots.filter((k) => k.id !== (payload.old as { id: string }).id);
              }

              return existingKots;
            },
          );
        },
      )
      // 4. TARGETED BROADCAST EVENTS (Lightweight Signal Bus)
      .on("broadcast", { event: "patch_state" }, ({ payload }) => {
        if (!payload || !payload.queryKey) return;
        queryClient.setQueriesData({ queryKey: payload.queryKey }, (oldData) => {
          if (typeof payload.updater === "function") {
            return payload.updater(oldData);
          }
          if (oldData && typeof oldData === "object") {
            return { ...oldData, ...payload.patch };
          }
          return payload.patch;
        });
      });

    // Subscribe channel
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        setRealtimeState("live");
      } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
        setRealtimeState("offline");
      }
    });

    return () => {
      setRealtimeState("connecting");
      void supabase.removeChannel(channel);
    };
  }, [branchId, queryClient]);
}
