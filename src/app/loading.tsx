export default function Loading() {
  return (
    <div role="status" aria-label="Loading financial view" className="animate-in fade-in space-y-8 delay-150 duration-500 fill-mode-both">
      <div className="space-y-2"><div className="bg-muted h-6 w-48 rounded-md motion-safe:animate-pulse" /><div className="bg-muted/70 h-4 w-80 max-w-full rounded-md motion-safe:animate-pulse" /></div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-6 lg:grid-cols-4">{[0, 1, 2, 3].map(i => <div key={i} className="space-y-2"><div className="bg-muted/70 h-3 w-20 rounded motion-safe:animate-pulse" /><div className="bg-muted h-7 w-32 rounded-md motion-safe:animate-pulse" /></div>)}</div>
      <div className="bg-muted/60 h-72 rounded-xl motion-safe:animate-pulse" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
