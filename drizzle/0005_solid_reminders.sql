CREATE TABLE `cancellation_reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`dueDate` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'active' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`completedAt` integer
);
--> statement-breakpoint
CREATE INDEX `cancellation_reminder_due_idx` ON `cancellation_reminders` (`dueDate`);
