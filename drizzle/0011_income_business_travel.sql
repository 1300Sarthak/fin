CREATE TABLE `business_expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`taxYear` integer NOT NULL,
	`datePurchased` text,
	`item` text NOT NULL,
	`amountCents` integer,
	`paymentMethod` text,
	`businessPct` integer DEFAULT 100 NOT NULL,
	`category` text,
	`txnId` integer,
	`note` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `business_expenses_year_idx` ON `business_expenses` (`taxYear`);--> statement-breakpoint
CREATE TABLE `income_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sourceId` integer NOT NULL,
	`workMonth` text,
	`workDate` text,
	`hours` real,
	`rateCents` integer,
	`amountCents` integer NOT NULL,
	`taxable` integer,
	`paidOn` text,
	`txnId` integer,
	`note` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`sourceId`) REFERENCES `income_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `income_entries_source_idx` ON `income_entries` (`sourceId`);--> statement-breakpoint
CREATE INDEX `income_entries_txn_idx` ON `income_entries` (`txnId`);--> statement-breakpoint
CREATE TABLE `income_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`taxTreatment` text DEFAULT 'se' NOT NULL,
	`matchPattern` text,
	`hourlyRateCents` integer,
	`note` text,
	`archived` integer DEFAULT false NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `income_sources_name_unique` ON `income_sources` (`name`);--> statement-breakpoint
CREATE TABLE `loyalty_programs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`statusTier` text,
	`memberLast4` text,
	`valueCentsPerPoint` integer,
	`note` text,
	`balanceAsOf` text,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_programs_name_unique` ON `loyalty_programs` (`name`);--> statement-breakpoint
CREATE TABLE `trip_bookings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`programId` integer,
	`title` text NOT NULL,
	`startDate` text NOT NULL,
	`endDate` text,
	`location` text,
	`costCents` integer,
	`pointsUsed` integer,
	`bookedVia` text,
	`status` text DEFAULT 'booked' NOT NULL,
	`note` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`programId`) REFERENCES `loyalty_programs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `trip_bookings_start_idx` ON `trip_bookings` (`startDate`);