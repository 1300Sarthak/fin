import type { NextResponse } from "next/server";
import { REMEMBER_MS, SESSION_COOKIE, type SessionPayload } from "./session";

/** HttpOnly, SameSite=Lax, Path=/; persistent only with "remember me", otherwise gone when the browser closes. */
export function setSessionCookie(response: NextResponse, token: string, payload: SessionPayload, secure: boolean) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    ...(payload.remember ? { maxAge: Math.floor(REMEMBER_MS / 1000) } : {}),
  });
}

export function clearSessionCookie(response: NextResponse, secure: boolean) {
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 0 });
}
