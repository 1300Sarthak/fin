import {
  Wallet,
  PiggyBank,
  CreditCard,
  TrendingUp,
  Landmark,
  Bitcoin,
  Banknote,
  HandCoins,
  HeartPulse,
  type LucideIcon,
} from "lucide-react";
import type { AccountType } from "@/db/schema";

const ICONS: Record<AccountType, LucideIcon> = {
  checking: Wallet,
  savings: PiggyBank,
  hysa: PiggyBank,
  hsa: HeartPulse,
  credit: CreditCard,
  brokerage: TrendingUp,
  ira: Landmark,
  crypto: Bitcoin,
  cash: Banknote,
  loan: HandCoins,
  other: Wallet,
};

export function AccountIcon({
  type,
  className,
}: {
  type: AccountType;
  className?: string;
}) {
  const Icon = ICONS[type] ?? Wallet;
  return <Icon className={className} />;
}
