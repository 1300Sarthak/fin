"use client";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Next 16 prefers `retry()` over `reset()`: it refetches the segment, not just the boundary. */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <section role="alert" className="bg-card/40 mx-auto my-12 max-w-lg rounded-xl border border-dashed p-8 text-center">
      <div className="bg-muted text-warning mx-auto mb-4 grid size-12 place-items-center rounded-full">
        <TriangleAlert className="size-6" aria-hidden="true" />
      </div>
      <h1 className="text-base font-medium">This view couldn’t load</h1>
      <p className="text-muted-foreground mx-auto mt-1.5 max-w-md text-sm text-pretty">
        Trying again usually fixes it. On a fresh clone, run the migration and seed commands from the setup guide first.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button size="sm" onClick={() => retry()}>Try again</Button>
        <Link href="/guide" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>Setup guide</Link>
      </div>
      {error.digest && (
        <p className="text-muted-foreground mt-4 font-mono text-xs">Reference: {error.digest}</p>
      )}
    </section>
  );
}
