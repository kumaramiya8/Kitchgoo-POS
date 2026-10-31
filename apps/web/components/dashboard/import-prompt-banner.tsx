"use client";

import { useState } from "react";
import { DownloadCloud, Sparkles, Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";

export function ImportPromptBanner({ branchId }: { branchId: string | null }) {
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState(false);
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["import", "status", branchId],
    queryFn: () =>
      api.get<{
        categoriesCount: number;
        itemsCount: number;
        ordersCount: number;
        availableToImport: { menuItems: number; categories: number; historicalInvoices: number };
      }>("/import/seed"),
    staleTime: 60_000,
  });

  // If already imported with items and orders, hide the prompt
  if (!status || (status.itemsCount >= 10 && status.ordersCount >= 10) || done) {
    return null;
  }

  const handleImport = async () => {
    setImporting(true);
    try {
      const res = await api.post<{
        success: boolean;
        message: string;
      }>(`/import/seed?branchId=${branchId || ""}`);

      toast.success(res.message || "Data imported successfully!");
      setDone(true);
      queryClient.invalidateQueries({ queryKey: ["menu"] });
      queryClient.invalidateQueries({ queryKey: ["floors"] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["import"] });
    } catch (err: any) {
      toast.error(err?.message || "Failed to import data");
    } finally {
      setImporting(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4 border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/20 text-primary">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-foreground">
            Setup Restaurant from Previous Software
          </h3>
          <p className="text-sm text-muted-foreground">
            We found 77 menu items across 14 categories and past sales history ready to import into your account.
          </p>
        </div>
      </div>
      <Button
        className="shrink-0 gap-2 font-medium"
        disabled={importing}
        onClick={handleImport}
      >
        {importing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <DownloadCloud className="h-4 w-4" />
        )}
        {importing ? "Importing Data..." : "Import 77 Items & Sales"}
      </Button>
    </Card>
  );
}
