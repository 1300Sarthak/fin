CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text DEFAULT 'fact' NOT NULL,
	`body` text NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`doneAt` integer
);
--> statement-breakpoint
CREATE INDEX `note_kind_idx` ON `notes` (`kind`);--> statement-breakpoint
CREATE INDEX `note_created_idx` ON `notes` (`createdAt`);