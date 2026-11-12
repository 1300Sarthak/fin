CREATE TABLE `credit_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`issuer` text,
	`accountId` integer,
	`rewardCurrency` text DEFAULT 'cash' NOT NULL,
	`baseRateBp` integer DEFAULT 100 NOT NULL,
	`categoryRatesJson` text DEFAULT '[]' NOT NULL,
	`annualFeeCents` integer DEFAULT 0 NOT NULL,
	`foreignFeeBp` integer,
	`perks` text,
	`openedOn` text,
	`active` integer DEFAULT true NOT NULL,
	`note` text,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`accountId`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_cards_name_unique` ON `credit_cards` (`name`);