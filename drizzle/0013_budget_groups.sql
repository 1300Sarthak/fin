CREATE TABLE `budget_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`limitCents` integer NOT NULL,
	`period` text DEFAULT 'monthly' NOT NULL,
	`categoryIdsJson` text DEFAULT '[]' NOT NULL,
	`catchAll` integer DEFAULT false NOT NULL,
	`sortOrder` integer DEFAULT 0 NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_groups_name_unique` ON `budget_groups` (`name`);