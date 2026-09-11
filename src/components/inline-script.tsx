/**
 * Renders an inline `<script>` that runs synchronously during HTML parsing
 * (before first paint) on hard navigations. Per the Next.js "preventing flash
 * before hydration" guide, React warns when a component renders a real
 * `<script>` tag, so we emit `text/javascript` on the server (where it executes)
 * and `text/plain` on the client (so React doesn't try to run it again or warn).
 * `suppressHydrationWarning` accepts the type attribute mismatch.
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
