"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowUpRight, Download, FileSpreadsheet, Loader2, Trash2, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { SpreadsheetDocument } from "@/lib/spreadsheet-core";
import { pluralize } from "@/lib/format";

export type UploadSummary = Omit<SpreadsheetDocument, "sheets">;
export function SettingsDataControls({ initialUploads }: { initialUploads: UploadSummary[] }) {
  const [uploads, setUploads] = useState(initialUploads);
  const [busy, setBusy] = useState<string | null>(null);
  const [share, setShare] = useState(false);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) { setFailed(true); setStatus("Choose a CSV or XLSX file first."); return; }
    if (file.size > 5 * 1024 * 1024) { setFailed(true); setStatus("File exceeds the 5 MB limit."); return; }
    setBusy("upload"); setFailed(false); setStatus("");
    try {
      const form = new FormData(); form.append("file", file); form.append("shareWithAgent", String(share));
      const response = await fetch("/api/spreadsheets", { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Upload failed.");
      setUploads(current => [result.upload, ...current]);
      setStatus("Spreadsheet summarized and saved locally. Expand it below to inspect the results.");
      if (fileRef.current) fileRef.current.value = "";
    } catch (error) { setFailed(true); setStatus(error instanceof Error ? error.message : "Upload failed."); }
    finally { setBusy(null); }
  }
  async function mutate(id: string, method: "DELETE" | "PATCH", shareWithAgent?: boolean) {
    setBusy(id); setStatus(""); setFailed(false);
    try {
      const response = await fetch("/api/spreadsheets", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, shareWithAgent }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not update the spreadsheet.");
      setUploads(current => method === "DELETE" ? current.filter(item => item.id !== id) : current.map(item => item.id === id ? { ...item, shareWithAgent: !!shareWithAgent } : item));
      setStatus(method === "DELETE" ? "Spreadsheet removed from local storage and future agent context." : "Sharing preference saved. This applies to future requests.");
    } catch (error) { setFailed(true); setStatus(error instanceof Error ? error.message : "Could not update the spreadsheet."); }
    finally { setBusy(null); }
  }
  async function download() {
    setBusy("export"); setStatus(""); setFailed(false);
    try {
      const response = await fetch("/api/export", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not create the export. Please try again.");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `finance-export-${new Date().toISOString().slice(0, 10)}.xlsx`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Your XLSX export is ready in your downloads.");
    } catch (error) { setFailed(true); setStatus(error instanceof Error ? error.message : "Export failed."); }
    finally { setBusy(null); }
  }
  return <div className="mt-6 max-w-5xl space-y-6">
    {status ? <p role={failed ? "alert" : "status"} className={`rounded-lg border p-3 text-sm ${failed ? "text-destructive" : "text-primary"}`}>{status}</p> : null}
    <Card id="spreadsheets"><CardHeader><CardTitle className="flex items-center gap-2"><FileSpreadsheet className="size-4" />Spreadsheet knowledge</CardTitle><p className="text-sm text-muted-foreground">Bring a budget, benefits worksheet, portfolio model, or other table into your financial plan.</p></CardHeader><CardContent className="space-y-5">
      <form onSubmit={upload} className="space-y-3 rounded-xl border border-dashed bg-muted/20 p-5">
        <label className="block text-sm font-medium" htmlFor="planning-spreadsheet">Choose a spreadsheet</label>
        <input ref={fileRef} id="planning-spreadsheet" className="block min-h-11 w-full max-w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-2 file:text-foreground" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy !== null} />
        <p className="text-xs leading-relaxed text-muted-foreground">CSV or XLSX · 5 MB per file · 10 files · 10 sheets · 10,000 total data rows · 50 columns. The first row is treated as headers. Export other formats to CSV or XLSX.</p>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm"><input type="checkbox" className="size-4 accent-primary" checked={share} onChange={event => setShare(event.target.checked)} />Allow the research assistant to use this spreadsheet’s summary and preview</label>
        <p className="text-xs leading-relaxed text-muted-foreground">Local summaries are free and require no AI key. If you enable sharing, column statistics and the first five rows may be sent to your configured AI provider during research. Uploading does not call an AI or add transactions to your ledger.</p>
        <Button type="submit" disabled={busy !== null || uploads.length >= 10} className="min-h-11 px-4">{busy === "upload" ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}{busy === "upload" ? "Reading spreadsheet…" : "Upload & summarize"}</Button>
      </form>
      <p className="text-xs leading-relaxed text-muted-foreground">Normalized visible-sheet values stay in the local database. Formulas are not evaluated and formula cells are left blank; upload a values-only copy to include them. Original files, hidden sheets, and embedded content are not stored. Column totals describe numeric values and do not infer currency, tax eligibility, or financial meaning.</p>
      {!uploads.length ? <div className="rounded-lg border p-5 text-center text-sm text-muted-foreground">Your spreadsheet library is empty. Add a file above to see its rows, columns, and numeric summaries.</div> : uploads.map(upload => <details key={upload.id} className="group rounded-xl border bg-background" open={uploads.length === 1}>
        <summary className="cursor-pointer px-4 py-4 text-sm font-medium"><span className="break-all">{upload.name}</span><span className="ml-2 text-xs font-normal text-muted-foreground">{pluralize(upload.summaries.reduce((sum, sheet) => sum + sheet.rowCount, 0), "row")} · {pluralize(upload.summaries.length, "sheet")} · {upload.shareWithAgent ? "Available to AI" : "Local only"}</span></summary>
        <div className="space-y-4 border-t p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-primary" checked={upload.shareWithAgent} disabled={busy !== null} onChange={event => mutate(upload.id, "PATCH", event.target.checked)} />Share summary and preview with the research assistant</label><Button variant="destructive" disabled={busy !== null} onClick={() => mutate(upload.id, "DELETE")} className="min-h-11 px-3"><Trash2 className="size-4" />Remove file</Button></div>
          {upload.shareWithAgent ? <div className="rounded-lg bg-muted/40 p-3"><Link href={`/assistant?mode=research&prompt=${encodeURIComponent(`Analyze the saved spreadsheet with id ${upload.id}. Explain patterns in its summaries, missing context, and useful next steps for my financial plan.`)}`} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary underline underline-offset-4">Analyze with the assistant<ArrowUpRight className="size-4" /></Link><p className="text-xs text-muted-foreground">Ask the assistant to analyze it; shared summaries are included automatically for personal questions. Provider usage may incur a charge.</p></div> : null}
          {upload.warnings.map(warning => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
          {upload.summaries.map((sheet, index) => <div key={`${sheet.name}-${index}`} className="space-y-3"><h3 className="text-sm font-semibold">{sheet.name} · {pluralize(sheet.rowCount, "data row")}</h3><div className="max-w-full overflow-x-auto rounded-lg border"><table className="w-full text-left text-xs"><caption className="sr-only">Column summaries for {sheet.name}</caption><thead className="bg-muted/40"><tr>{["Column", "Filled", "Numbers", "Sum", "Minimum", "Maximum"].map(label => <th key={label} className="whitespace-nowrap px-3 py-2 font-medium">{label}</th>)}</tr></thead><tbody>{sheet.columns.map((column, i) => <tr key={i} className="border-t"><td className="max-w-48 break-words px-3 py-2">{column.name}</td>{[column.filled, column.numericCount, column.sum, column.min, column.max].map((value, j) => <td key={j} className="whitespace-nowrap px-3 py-2 tabular-nums">{value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>)}</tr>)}</tbody></table></div><details className="text-xs"><summary className="cursor-pointer py-2 text-muted-foreground">Preview first {pluralize(sheet.preview.length, "row")} shared when enabled</summary><div className="max-w-full overflow-x-auto"><table className="w-full text-left"><thead><tr>{sheet.columns.map((column, i) => <th key={i} className="max-w-48 px-3 py-2">{column.name}</th>)}</tr></thead><tbody>{sheet.preview.map((row, i) => <tr key={i} className="border-t">{row.map((value, j) => <td key={j} className="max-w-64 break-words px-3 py-2">{value === null ? "—" : String(value)}</td>)}</tr>)}</tbody></table></div></details></div>)}
        </div>
      </details>)}
    </CardContent></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Download className="size-4" />Export your financial information</CardTitle><p className="text-sm text-muted-foreground">One Excel workbook with your accounts, transactions, holdings, goals, budgets, recurring items, milestones, notes, preferences, planning and tax inputs, and saved spreadsheet values.</p></CardHeader><CardContent className="space-y-3"><Button disabled={busy !== null} onClick={download} className="min-h-11 px-4">{busy === "export" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}{busy === "export" ? "Preparing workbook…" : "Export everything to XLSX"}</Button><p className="text-xs leading-relaxed text-muted-foreground">Includes local-only spreadsheets. Excludes API keys, bank connection credentials, provider identifiers, original upload binaries, and raw provider payloads. Money columns ending in Cents remain integer cents; a Read me sheet explains the format. This is a portable report, not a database restore file.</p></CardContent></Card>
  </div>;
}
