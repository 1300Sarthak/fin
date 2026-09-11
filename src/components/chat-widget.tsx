import Link from "next/link";
import { MessageCircle } from "lucide-react";

export function ChatWidget() {
  return (
    <Link href="/research" aria-label="Open financial research assistant" className="fixed right-4 bottom-4 z-40 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-colors hover:bg-primary/85 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
      <MessageCircle className="size-5" aria-hidden="true" />
    </Link>
  );
}
