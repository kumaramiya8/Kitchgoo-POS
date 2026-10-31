"use client";

import { useState } from "react";
import { DownloadCloud, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export function ImportDataButton({ branchId }: { branchId: string | null }) {
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();

  const handleImport = async () => {
    if (!confirm("Import your restaurant menu items and past invoices from your attached data?")) {
      return;
    }

    setLoading(true);
    try {
      const res = await api.post<{
        success: boolean;
        message: string;
        imported?: { categories: number; menuItems: number; orders: number };
      }>(`/import/seed?branchId=${branchId || ""}`);

      toast.success(res.message || "Data imported successfully!");
      // Invalidate all menu and floor queries so POS and Menu immediately show all items!
      queryClient.invalidateQueries({ queryKey: ["menu"] });
      queryClient.invalidateQueries({ queryKey: ["floors"] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (err: any) {
      toast.error(err?.message || "Failed to import data");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-2 border-primary/40 text-primary hover:bg-primary/10"
      disabled={loading}
      onClick={handleImport}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <DownloadCloud className="h-4 w-4" />
      )}
      {loading ? "Importing Data..." : "Import Previous Software Data"}
    </Button>
  );
}
