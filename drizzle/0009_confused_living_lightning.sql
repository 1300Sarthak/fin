CREATE TABLE `holdings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`accountId` integer NOT NULL,
	`externalId` text NOT NULL,
	`symbol` text,
	`description` text,
	`shares` real DEFAULT 0 NOT NULL,
	`marketValueCents` integer DEFAULT 0 NOT NULL,
	`costPerShareCents` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	`asOf` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`accountId`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `holding_account_idx` ON `holdings` (`accountId`);--> statement-breakpoint
CREATE UNIQUE INDEX `holding_account_external_uq` ON `holdings` (`accountId`,`externalId`);