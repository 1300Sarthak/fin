"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

/** A select that filters the current page by account via an `?account=` param,
 *  preserving any other query params (search, month, etc.). */
export function AccountFilter({
  accounts,
}: {
  accounts: { id: number; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const current = sp.get("account") ?? "";

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams(sp.toString());
    if (e.target.value) params.set("account", e.target.value);
    else params.delete("account");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  if (accounts.length === 0) return null;

  return (
    <select
      value={current}
      onChange={onChange}
      aria-label="Filter by account"
      className="border-input bg-transparent dark:bg-input/30 h-9 rounded-md border px-3 text-sm shadow-xs outline-none"
    >
      <option value="">All accounts</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}
