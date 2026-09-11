import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { cancellationReminders } from "@/db/schema";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type CancellationReminderInput = {
  name: string;
  dueDate: string;
  note?: string;
};

/** Validate a calendar date without allowing JavaScript's overflow dates. */
export function validateReminderDate(value: string): string {
  if (!ISO_DATE.test(value)) throw new Error("Due date must use YYYY-MM-DD.");
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Due date is not a real calendar date.");
  }
  return value;
}

function validateName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Reminder name is required.");
  if (name.length > 120) throw new Error("Reminder name must be 120 characters or fewer.");
  return name;
}

export async function createCancellationReminder(input: CancellationReminderInput) {
  const name = validateName(input.name);
  const dueDate = validateReminderDate(input.dueDate);
  const note = input.note?.trim().slice(0, 500) || null;

  // Tool-capable models can retry a function call. Treat an exact active
  // reminder as the same intent, rather than cluttering the user's list.
  const existing = await db.query.cancellationReminders.findFirst({
    where: and(
      eq(cancellationReminders.name, name),
      eq(cancellationReminders.dueDate, dueDate),
      eq(cancellationReminders.status, "active"),
    ),
  });
  if (existing) return { reminder: existing, created: false };

  const [reminder] = await db
    .insert(cancellationReminders)
    .values({ name, dueDate, note })
    .returning();
  return { reminder, created: true };
}

export async function getCancellationReminders(opts?: { includeCompleted?: boolean }) {
  const rows = await db
    .select()
    .from(cancellationReminders)
    .where(opts?.includeCompleted ? undefined : eq(cancellationReminders.status, "active"))
    .orderBy(asc(cancellationReminders.dueDate), asc(cancellationReminders.name));
  return rows;
}

export async function setCancellationReminderStatus(id: number, status: "active" | "completed") {
  if (!Number.isInteger(id) || id <= 0) throw new Error("A valid reminder id is required.");
  const [reminder] = await db
    .update(cancellationReminders)
    .set({ status, completedAt: status === "completed" ? new Date() : null })
    .where(eq(cancellationReminders.id, id))
    .returning();
  if (!reminder) throw new Error("Reminder not found.");
  return reminder;
}
