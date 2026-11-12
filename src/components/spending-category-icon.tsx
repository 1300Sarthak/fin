import {
  Baby, Banknote, Car, CircleHelp, Clapperboard, Coffee, CreditCard, Dumbbell, Fuel, Gift, GraduationCap, HeartPulse,
  Home, Landmark, type LucideIcon, Pill, Plane, Plug, Receipt, Repeat, Scissors, ShoppingBag, ShoppingCart, Shirt,
  Smartphone, SquareParking, Stethoscope, TrainFront, Tv, Utensils, UtensilsCrossed, Wifi, Wrench, Zap, Laptop, CarTaxiFront,
  Sandwich, Package, Layers,
} from "lucide-react";
import { createElement } from "react";
import { cn } from "@/lib/utils";

/** Lowercased category name → icon. Unknown names fall back to their parent's, then a neutral mark. */
const BY_NAME: Record<string, LucideIcon> = {
  housing: Home, "rent / mortgage": Home, "home utilities": Plug,
  groceries: ShoppingCart, "food & dining": Utensils, restaurants: UtensilsCrossed, "coffee shops": Coffee, "fast food": Sandwich,
  transportation: Car, gas: Fuel, rideshare: CarTaxiFront, "public transit": TrainFront, parking: SquareParking,
  shopping: ShoppingBag, clothing: Shirt, electronics: Laptop, "general merchandise": Package,
  subscriptions: Repeat, streaming: Tv, software: Layers, memberships: CreditCard,
  "bills & utilities": Receipt, phone: Smartphone, internet: Wifi, "electric & gas": Zap,
  "health & fitness": HeartPulse, pharmacy: Pill, gym: Dumbbell, medical: Stethoscope,
  entertainment: Clapperboard, travel: Plane, education: GraduationCap, "personal care": Scissors,
  "gifts & donations": Gift, "fees & charges": Banknote, taxes: Landmark, childcare: Baby, "home improvement": Wrench,
};

export function categoryIcon(name: string, parent?: string): LucideIcon {
  return BY_NAME[name.toLowerCase()] ?? (parent ? BY_NAME[parent.toLowerCase()] : undefined) ?? CircleHelp;
}

/** A small muted tile with the category's icon; decorative, the name carries meaning. */
export function CategoryIcon({ name, parent, className }: { name: string; parent?: string; className?: string }) {
  // The icon is a static lucide component looked up from a table, not one built per render.
  return (
    <span aria-hidden="true" className={cn("bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center rounded-lg", className)}>
      {createElement(categoryIcon(name, parent), { className: "size-4" })}
    </span>
  );
}
