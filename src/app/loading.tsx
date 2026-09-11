export default function Loading() {
  return <div role="status" aria-label="Loading financial view" className="space-y-6 motion-safe:animate-pulse"><div className="h-8 w-56 rounded bg-muted" /><div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map(i => <div key={i} className="h-28 rounded-xl bg-muted" />)}</div><div className="h-72 rounded-xl bg-muted" /><span className="sr-only">Loading…</span></div>;
}
