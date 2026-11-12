import { LogOut } from "lucide-react";
import { authEnabled } from "@/lib/auth/env";
import { Button } from "@/components/ui/button";

/**
 * Sign-out controls. Plain form posts to /api/auth/logout, so they work before
 * hydration and need no client state; the route answers with a 303 to /login.
 * Render nothing when sign-in is off (loopback dev without FIN_PASSWORD_HASH).
 */
export function SignOutButton() {
  if (!authEnabled()) return null;
  return (
    <form method="post" action="/api/auth/logout">
      <Button type="submit" variant="ghost" size="icon" aria-label="Sign out" title="Sign out">
        <LogOut className="size-4" aria-hidden="true" />
      </Button>
    </form>
  );
}

/** For Settings: ends every session on every device by bumping the session generation. */
export function SignOutEverywhereButton() {
  if (!authEnabled()) return null;
  return (
    <form method="post" action="/api/auth/logout">
      <input type="hidden" name="everywhere" value="1" />
      <Button type="submit" variant="outline" size="sm">Sign out everywhere</Button>
    </form>
  );
}
