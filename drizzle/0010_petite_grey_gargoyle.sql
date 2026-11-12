CREATE TABLE `ledger_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`kind` text NOT NULL,
	`txnId` integer NOT NULL,
	`summary` text NOT NULL,
	`beforeJson` text NOT NULL,
	`afterJson` text NOT NULL,
	`appliedAt` integer,
	`undoneAt` integer,
	`origin` text DEFAULT 'assistant' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ledger_changes_txn_idx` ON `ledger_changes` (`txnId`);--> statement-breakpoint
CREATE INDEX `ledger_changes_status_idx` ON `ledger_changes` (`status`);