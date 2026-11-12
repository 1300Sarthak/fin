import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readAuthConfig } from "@/lib/auth/env";
import { getSessionGeneration } from "@/lib/auth/generation";
import { sanitizeNext } from "@/lib/auth/next-param";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth/session";
import { LoginScreen } from "./login-screen";

export const metadata: Metadata = { title: "Sign in to Finance", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = sanitizeNext(first(params.next) ?? "/");
  const config = readAuthConfig();
  if (config.state === "enabled") {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (token && isValidSession(token, config.secret, await getSessionGeneration())) redirect(next);
  }
  const signedOut = first(params.signedOut);
  return (
    <LoginScreen
      next={next}
      configured={config.state === "enabled"}
      notice={signedOut === "all" ? "Signed out on every device." : signedOut === "1" ? "Signed out." : null}
    />
  );
}
