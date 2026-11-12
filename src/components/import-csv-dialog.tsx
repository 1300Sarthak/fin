"use client";

import * as React from "react";
import { Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

type AccountOption = { id: number; name: string };

export function ImportCsvDialog({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [accountId, setAccountId] = React.useState<string>("");
  const [flipSigns, setFlipSigns] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);

  const disabled = accounts.length === 0;

  async function submit() {
    if (!accountId) return toast.error("Choose an account");
    if (!file) return toast.error("Choose a CSV file");
    setBusy(true);
    const t = toast.loading("Importing…");
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("accountId", accountId);
      fd.set("flipSigns", String(flipSigns));
      const res = await fetch("/api/import/csv", { method: "POST", body: fd });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Import failed");
      toast.success(data.message ?? "Imported", { id: t });
      setOpen(false);
      setFile(null);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed", { id: t });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" disabled={disabled}>
            <Upload className="size-4" />
            Import CSV
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import transactions from CSV</DialogTitle>
          <DialogDescription>
            Backfill older history (SimpleFIN only returns ~90 days) or import an
            account it can&apos;t reach. Re-importing the same file is safe.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="csv-account">Account</Label>
            <select
              id="csv-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="border-input bg-transparent dark:bg-input/30 h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="">Select an account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="csv-file">CSV file</Label>
            <input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-muted-foreground file:bg-secondary file:text-secondary-foreground block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-1.5 file:text-sm"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={flipSigns}
              onChange={(e) => setFlipSigns(e.target.checked)}
              className="size-4"
            />
            Flip signs (use if purchases import as positive)
          </label>
        </div>

        <DialogFooter>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
