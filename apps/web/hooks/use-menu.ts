"use client";

import type { MenuCategoryDto, MenuItemDto } from "@nodedr-restaurant/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import {
  getCachedMenu,
  saveCatalogDelta,
  type CatalogDelta,
} from "@/lib/indexed-db";

export interface MenuCategory {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  showOnWebsite: boolean;
  _count: { items: number };
}

export interface KitchenStation {
  id: string;
  name: string;
}

export interface Modifier {
  id: string;
  name: string;
  priceAdjustment: string;
  isDefault: boolean;
}

export interface ModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  isRequired: boolean;
  modifiers: Modifier[];
}

export interface MenuItem {
  id: string;
  categoryId: string;
  stationId: string | null;
  name: string;
  imageUrl: string | null;
  price: string;
  halfPrice: string | null;
  taxRatePercent: string;
  isVeg: boolean;
  isActive: boolean;
  isCombo: boolean;
  category: { id: string; name: string };
  station: { id: string; name: string } | null;
  modifierGroups: { modifierGroup: ModifierGroup }[];
}

/**
 * Local-first catalog hook using IndexedDB.
 * Returns instantaneous cached menu items/categories mid-shift (0ms, 0 network egress),
 * and only performs background delta syncs for modified rows.
 */
export function useLocalMenuCatalog(branchId: string | null) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ["menu", "catalog", branchId],
    queryFn: async () => {
      if (!branchId) return { categories: [], items: [], modifiers: [] };

      // 1. Read instant local cache from IndexedDB
      const cached = await getCachedMenu(branchId);

      // 2. Perform lightweight Delta Sync if online
      try {
        const since = cached.lastSyncedAt ?? new Date(0).toISOString();
        const { data: delta, error } = await supabase.rpc("get_catalog_delta", {
          p_branch_id: branchId,
          p_since: since,
        });

        if (!error && delta) {
          const catalogDelta = delta as CatalogDelta;
          if (
            catalogDelta.categories.length > 0 ||
            catalogDelta.items.length > 0 ||
            catalogDelta.modifiers.length > 0
          ) {
            await saveCatalogDelta(branchId, catalogDelta);
            // Re-read updated local store
            return await getCachedMenu(branchId);
          }
        }
      } catch (err) {
        console.warn("Delta sync failed, continuing with local IndexedDB cache:", err);
      }

      return cached;
    },
    staleTime: 1000 * 60 * 60, // 1 hour stale time for static catalog data
    gcTime: 1000 * 60 * 60 * 24, // 24 hour retention
    enabled: !!branchId,
  });
}

export function useCategories(branchId: string | null) {
  const catalogQuery = useLocalMenuCatalog(branchId);

  return useQuery({
    queryKey: ["menu", "categories", branchId],
    queryFn: async () => {
      if (catalogQuery.data?.categories && catalogQuery.data.categories.length > 0) {
        return catalogQuery.data.categories.map((c) => ({
          ...c,
          _count: { items: c.itemCount ?? 0 },
        })) as MenuCategory[];
      }
      return api.get<MenuCategory[]>(`/menu/categories?branchId=${branchId}`);
    },
    enabled: !!branchId,
    initialData: () => {
      if (!catalogQuery.data?.categories) return undefined;
      return catalogQuery.data.categories.map((c) => ({
        ...c,
        _count: { items: c.itemCount ?? 0 },
      })) as MenuCategory[];
    },
    staleTime: 1000 * 60 * 30, // 30 mins
  });
}

export function useStations(branchId: string | null) {
  return useQuery({
    queryKey: ["menu", "stations", branchId],
    queryFn: () => api.get<KitchenStation[]>(`/menu/stations?branchId=${branchId}`),
    enabled: !!branchId,
    staleTime: 1000 * 60 * 60,
  });
}

export function useMenuItems(branchId: string | null, categoryId?: string) {
  const catalogQuery = useLocalMenuCatalog(branchId);

  const formatCachedItem = (i: any): MenuItem => ({
    id: i.id,
    categoryId: i.categoryId,
    stationId: i.stationId ?? null,
    name: i.name,
    imageUrl: i.imageUrl ?? null,
    price: String(i.price),
    halfPrice: i.halfPrice != null ? String(i.halfPrice) : null,
    taxRatePercent: String(i.taxRatePercent ?? "0"),
    isVeg: i.isVeg ?? true,
    isActive: i.isActive ?? true,
    isCombo: i.isCombo ?? false,
    category: i.category ?? { id: i.categoryId, name: "" },
    station: i.station ?? null,
    modifierGroups: i.modifierGroups ?? [],
  });

  return useQuery({
    queryKey: ["menu", "items", branchId, categoryId],
    queryFn: async () => {
      if (catalogQuery.data?.items && catalogQuery.data.items.length > 0) {
        let items = catalogQuery.data.items.map(formatCachedItem);
        if (categoryId) {
          items = items.filter((i) => i.categoryId === categoryId);
        }
        return items;
      }
      return api.get<MenuItem[]>(
        `/menu/items?branchId=${branchId}${categoryId ? `&categoryId=${categoryId}` : ""}`,
      );
    },
    enabled: !!branchId,
    initialData: () => {
      if (!catalogQuery.data?.items) return undefined;
      let items = catalogQuery.data.items.map(formatCachedItem);
      return categoryId ? items.filter((i) => i.categoryId === categoryId) : items;
    },
    staleTime: 1000 * 60 * 30,
  });
}

export function useCreateCategory(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: MenuCategoryDto) =>
      api.post(`/menu/categories?branchId=${branchId}`, dto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu", "catalog", branchId] });
      queryClient.invalidateQueries({ queryKey: ["menu", "categories", branchId] });
    },
  });
}

export function useUpdateCategory(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: Partial<MenuCategoryDto> }) =>
      api.patch(`/menu/categories/${id}?branchId=${branchId}`, dto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu", "catalog", branchId] });
      queryClient.invalidateQueries({ queryKey: ["menu", "categories", branchId] });
    },
  });
}

export function useDeleteCategory(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/menu/categories/${id}?branchId=${branchId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu", "catalog", branchId] });
      queryClient.invalidateQueries({ queryKey: ["menu", "categories", branchId] });
      queryClient.invalidateQueries({ queryKey: ["menu", "items", branchId] });
    },
  });
}

export function useUploadItemImage() {
  return useMutation({
    mutationFn: (file: File) => api.upload<{ url: string }>("/menu/items/upload-image", file),
  });
}

export function useCreateMenuItem(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: MenuItemDto) => api.post(`/menu/items?branchId=${branchId}`, dto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu", "catalog", branchId] });
      queryClient.invalidateQueries({ queryKey: ["menu", "items", branchId] });
    },
  });
}

export function useUpdateMenuItem(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: Partial<MenuItemDto> }) =>
      api.patch(`/menu/items/${id}?branchId=${branchId}`, dto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu", "catalog", branchId] });
      queryClient.invalidateQueries({ queryKey: ["menu", "items", branchId] });
    },
  });
}

export function useDeleteMenuItem(branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/menu/items/${id}?branchId=${branchId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu", "catalog", branchId] });
      queryClient.invalidateQueries({ queryKey: ["menu", "items", branchId] });
    },
  });
}
