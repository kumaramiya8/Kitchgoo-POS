"use client";

import { useState } from "react";
import { DownloadCloud, Upload, CheckCircle2, Loader2, FileSpreadsheet, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

function parseCsvLine(line: string): string[] {
  const parts: string[] = [];
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

export function ImportInvoicesDialog({ branchId }: { branchId: string | null }) {
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; percent: number } | null>(null);
  const [completed, setCompleted] = useState(false);
  const queryClient = useQueryClient();

  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: ["import", "invoices-status", branchId],
    queryFn: () =>
      api.get<{
        importedCount: number;
        totalBundled: number;
        remainingBundled: number;
      }>(`/import/invoices?branchId=${branchId || ""}`),
    enabled: open,
  });

  const handleImportAllBundled = async () => {
    setImporting(true);
    setCompleted(false);
    const total = status?.totalBundled || 2008;
    const batchSize = 200;
    let importedTotal = 0;

    try {
      for (let offset = 0; offset < total; offset += batchSize) {
        const res = await api.post<{
          success: boolean;
          importedCount: number;
          skippedCount?: number;
        }>(`/import/invoices?branchId=${branchId || ""}`, {
          offset,
          limit: batchSize,
        });

        importedTotal += res.importedCount || 0;
        const currentProgress = Math.min(total, offset + batchSize);
        const percent = Math.round((currentProgress / total) * 100);
        setProgress({ current: currentProgress, total, percent });
      }

      setCompleted(true);
      toast.success(`Successfully imported all past invoices!`);
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      refetchStatus();
    } catch (err: any) {
      toast.error(err?.message || "Error importing invoices batch");
    } finally {
      setImporting(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setCompleted(false);

    try {
      const text = await file.text();
      const lines = text.trim().split("\n");
      if (lines.length < 2) {
        throw new Error("CSV file is empty or missing headers");
      }

      const invoicesMap = new Map<string, any>();
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const parts = parseCsvLine(lines[i]);
        const [
          saleDate, invoiceNo, guestName, itemName, category, qty,
          salesExcTax, tax, salesIncTax, discount, collected, due, paymentType, status
        ] = parts;

        if (invoiceNo) {
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
      }

      const parsedInvoices = Array.from(invoicesMap.values());
      const total = parsedInvoices.length;
      const batchSize = 150;

      for (let i = 0; i < total; i += batchSize) {
        const batch = parsedInvoices.slice(i, i + batchSize);
        await api.post(`/import/invoices?branchId=${branchId || ""}`, {
          invoices: batch,
        });

        const current = Math.min(total, i + batchSize);
        const percent = Math.round((current / total) * 100);
        setProgress({ current, total, percent });
      }

      setCompleted(true);
      toast.success(`Imported ${total} invoices from ${file.name}!`);
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      refetchStatus();
    } catch (err: any) {
      toast.error(err?.message || "Failed to process CSV file");
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="gap-2 border-primary/40 text-primary hover:bg-primary/10">
            <DownloadCloud className="h-4 w-4" />
            Import Past Invoices
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-semibold">
            <FileSpreadsheet className="h-5 w-5 text-primary" />
            Import Past Sales & Invoices
          </DialogTitle>
          <DialogDescription>
            Import historical sales records to populate analytics, sales trends, and order history.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-3">
          {/* Status summary */}
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-secondary/30 p-3 text-sm">
            <div>
              <span className="text-xs text-muted-foreground">Invoices in System</span>
              <p className="text-lg font-semibold text-foreground">{status?.importedCount ?? "..."}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Available from Previous Software</span>
              <p className="text-lg font-semibold text-primary">{status?.totalBundled ?? "2,008"} invoices</p>
            </div>
          </div>

          {/* Progress bar if actively importing */}
          {importing && progress && (
            <div className="flex flex-col gap-2 rounded-xl border border-primary/20 bg-primary/5 p-4">
              <div className="flex items-center justify-between text-xs font-medium">
                <span className="flex items-center gap-1.5 text-primary">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Importing records...
                </span>
                <span className="tabular-nums text-foreground">{progress.percent}% ({progress.current} / {progress.total})</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            </div>
          )}

          {/* Completed badge */}
          {completed && (
            <div className="flex items-center gap-2.5 rounded-xl border border-success/30 bg-success/10 p-3.5 text-sm text-success">
              <CheckCircle2 className="h-5 w-5 shrink-0" />
              <span>All invoices have been imported successfully! Your dashboard trends and order history are now up to date.</span>
            </div>
          )}

          {/* Primary Action: 1-Click Import of bundled invoices */}
          <div className="flex flex-col gap-2 rounded-xl border border-border p-4 transition hover:border-primary/40">
            <h4 className="text-sm font-semibold text-foreground">Import All 2,008 Attached Invoices</h4>
            <p className="text-xs text-muted-foreground">
              Includes all past sales data from your uploaded previous software dataset with exact dates, line items, and payment types.
            </p>
            <Button
              className="mt-2 w-full gap-2 font-medium"
              disabled={importing}
              onClick={handleImportAllBundled}
            >
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              {importing ? "Importing Invoices..." : "Import All 2,008 Invoices Now"}
            </Button>
          </div>

          {/* Secondary Action: Upload new CSV */}
          <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-4">
            <h4 className="text-sm font-semibold text-foreground">Upload Another Invoices CSV File</h4>
            <p className="text-xs text-muted-foreground">
              Upload any other exports from your previous billing software.
            </p>
            <label className="mt-2">
              <input
                type="file"
                accept=".csv"
                className="hidden"
                disabled={importing}
                onChange={handleFileUpload}
              />
              <span className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
                <Upload className="h-4 w-4" />
                Select CSV File
              </span>
            </label>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
