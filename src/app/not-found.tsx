import Link from "next/link";
import { Compass } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function NotFound() {
  return (
    <section className="bg-card/40 mx-auto my-12 max-w-lg rounded-xl border border-dashed p-8 text-center">
      <div className="bg-muted text-muted-foreground mx-auto mb-4 grid size-12 place-items-center rounded-full">
        <Compass className="size-6" aria-hidden="true" />
      </div>
      <p className="text-muted-foreground font-mono text-xs">404</p>
      <h1 className="mt-1 text-base font-medium">This page doesn’t exist</h1>
      <p className="text-muted-foreground mx-auto mt-1.5 max-w-md text-sm text-pretty">
        Press <kbd className="bg-muted rounded px-1.5 py-0.5 font-mono text-[11px]">⌘K</kbd> to search every page, or head back to the overview.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Link href="/" className={cn(buttonVariants({ size: "sm" }))}>Back to overview</Link>
        <Link href="/guide" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>CLI &amp; agent guide</Link>
      </div>
    </section>
  );
}
