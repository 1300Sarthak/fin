"use client";

import "./login.css";
import * as React from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { BrandMark } from "@/components/app-sidebar";
import { cn } from "@/lib/utils";

/** A wrong password moves the form a few pixels side to side; reduced motion gets the red border alone. */
const SHAKE: Keyframe[] = [
  { transform: "translateX(0)" },
  { transform: "translateX(-7px)" },
  { transform: "translateX(6px)" },
  { transform: "translateX(-4px)" },
  { transform: "translateX(2px)" },
  { transform: "translateX(0)" },
];

export function LoginScreen({ next, configured, notice }: { next: string; configured: boolean; notice: string | null }) {
  const [password, setPassword] = React.useState("");
  const [visible, setVisible] = React.useState(false);
  const [remember, setRemember] = React.useState(true);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  function reject(message: string) {
    setError(message);
    setPending(false);
    inputRef.current?.focus();
    inputRef.current?.select();
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      formRef.current?.animate(SHAKE, { duration: 360, easing: "cubic-bezier(0.36, 0.07, 0.19, 0.97)" });
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!password) return reject("Enter your password.");
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, remember, next }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; next?: string; error?: string } | null;
      if (response.ok && data?.ok) {
        // A full navigation, so the app shell renders fresh with the new cookie. Stay "pending" until it lands.
        window.location.replace(data.next ?? "/");
        return;
      }
      reject(data?.error ?? "Could not sign in. Try again.");
    } catch {
      reject("Could not reach Finance. Check your connection and try again.");
    }
  }

  return (
    <div
      data-login-screen=""
      className="bg-background fixed inset-0 z-[60] overflow-y-auto overscroll-contain"
    >
      <div className="flex min-h-dvh items-center justify-center px-4 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        <section className="w-full max-w-[22rem]" aria-labelledby="login-title">
          <div className="login-drop" style={{ "--i": 0 } as React.CSSProperties}>
            <BrandMark className="size-11 rounded-[11px] text-[19px]" />
          </div>
          <div className="login-drop mt-7" style={{ "--i": 1 } as React.CSSProperties}>
            <h1 id="login-title" className="text-[22px] leading-7 font-semibold tracking-[-0.02em]">Sign in to Finance</h1>
            <p className="text-muted-foreground mt-1.5 text-[14px] leading-5">Enter your password to open your accounts.</p>
          </div>

          {notice && (
            <p role="status" className="drop-in bg-muted text-foreground mt-6 rounded-lg px-3.5 py-2.5 text-[13px]">{notice}</p>
          )}

          <form
            ref={formRef}
            onSubmit={submit}
            method="post"
            action="/api/auth/login"
            noValidate
            aria-busy={pending}
            className="login-drop mt-7"
            style={{ "--i": 2 } as React.CSSProperties}
          >
            {/* Password managers pair a saved password with a username; there is only one owner. */}
            <input type="text" name="username" autoComplete="username" value="owner" readOnly hidden />

            <label htmlFor="password" className="text-[13px] font-medium">Password</label>
            <div className="relative mt-1.5">
              <input
                ref={inputRef}
                id="password"
                name="password"
                type={visible ? "text" : "password"}
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                autoFocus
                required
                value={password}
                onChange={(e) => { setPassword(e.target.value); if (error) setError(null); }}
                aria-invalid={error ? true : undefined}
                aria-describedby="login-error"
                disabled={pending}
                className={cn(
                  "border-input bg-background dark:bg-input/20 h-12 w-full rounded-lg border pr-12 pl-3.5 text-base outline-none sm:h-11 sm:text-[15px]",
                  "transition-[border-color,box-shadow] duration-150 hover:border-foreground/20",
                  "focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/20 focus-visible:outline-none disabled:opacity-60",
                  "aria-invalid:border-negative/70 aria-invalid:focus-visible:ring-negative/20",
                )}
              />
              <button
                type="button"
                onClick={() => { setVisible((v) => !v); inputRef.current?.focus(); }}
                aria-label={visible ? "Hide password" : "Show password"}
                aria-pressed={visible}
                aria-controls="password"
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1 grid size-10 -translate-y-1/2 touch-manipulation place-items-center rounded-md transition-colors duration-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:size-9"
              >
                {visible ? <EyeOff className="size-[18px]" aria-hidden="true" /> : <Eye className="size-[18px]" aria-hidden="true" />}
              </button>
            </div>
            <p id="login-error" aria-live="polite" className="text-negative mt-2 min-h-5 text-[13px] leading-5">{error}</p>

            <label className="text-muted-foreground mt-1 flex min-h-11 cursor-pointer items-center gap-2.5 text-[14px] select-none">
              <input
                type="checkbox"
                name="remember"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="login-check size-4 shrink-0 cursor-pointer"
              />
              Keep me signed in for 30 days
            </label>

            <button
              type="submit"
              disabled={pending}
              className="bg-primary text-primary-foreground mt-4 flex h-12 w-full touch-manipulation items-center justify-center gap-2 rounded-lg text-[15px] font-medium outline-none select-none transition-[transform,background-color,opacity] duration-150 ease-out hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-brand/40 active:scale-[0.98] disabled:cursor-default disabled:opacity-80 disabled:active:scale-100 sm:h-11"
            >
              {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {pending ? "Signing in" : "Sign in"}
            </button>
          </form>

          {!configured && (
            <p className="text-muted-foreground mt-8 text-[13px] leading-5">
              Sign-in is off on this computer because <code className="text-foreground text-[12px]">FIN_PASSWORD_HASH</code> is not set.{" "}
              <a href={next} className="text-foreground underline underline-offset-4">Continue to Finance</a>
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
