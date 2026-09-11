CREATE TABLE `net_worth_milestone_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`milestoneId` integer NOT NULL,
	`label` text NOT NULL,
	`cents` integer DEFAULT 0 NOT NULL,
	`note` text,
	`isExcluded` integer DEFAULT false NOT NULL,
	`sortOrder` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`milestoneId`) REFERENCES `net_worth_milestones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `milestone_line_idx` ON `net_worth_milestone_lines` (`milestoneId`);--> statement-breakpoint
CREATE TABLE `net_worth_milestones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`label` text NOT NULL,
	`totalCents` integer DEFAULT 0 NOT NULL,
	`goal` text,
	`note` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `milestone_date_idx` ON `net_worth_milestones` (`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `milestone_date_uq` ON `net_worth_milestones` (`date`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `isRefund` integer DEFAULT false NOT NULL;