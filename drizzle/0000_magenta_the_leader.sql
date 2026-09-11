CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`institutionId` integer,
	`externalId` text,
	`name` text NOT NULL,
	`type` text DEFAULT 'other' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`currentBalanceCents` integer DEFAULT 0 NOT NULL,
	`availableBalanceCents` integer,
	`isAsset` integer DEFAULT true NOT NULL,
	`isActive` integer DEFAULT true NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`lastSyncedAt` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`institutionId`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_external_uq` ON `accounts` (`externalId`);--> statement-breakpoint
CREATE TABLE `app_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `balance_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`accountId` integer NOT NULL,
	`date` text NOT NULL,
	`balanceCents` integer NOT NULL,
	`isAsset` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`accountId`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `snapshot_date_idx` ON `balance_snapshots` (`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `snapshot_account_date_uq` ON `balance_snapshots` (`accountId`,`date`);--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`categoryId` integer NOT NULL,
	`period` text DEFAULT 'monthly' NOT NULL,
	`limitCents` integer NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_category_period_uq` ON `budgets` (`categoryId`,`period`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`parentId` integer,
	`kind` text DEFAULT 'expense' NOT NULL,
	`icon` text,
	`color` text,
	`isSystem` integer DEFAULT true NOT NULL,
	`sortOrder` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `category_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pattern` text NOT NULL,
	`isRegex` integer DEFAULT false NOT NULL,
	`categoryId` integer NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`createdBy` text DEFAULT 'user' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'custom' NOT NULL,
	`targetCents` integer DEFAULT 0 NOT NULL,
	`annualCapCents` integer,
	`linkedAccountId` integer,
	`priority` integer DEFAULT 0 NOT NULL,
	`monthlyContributionCents` integer,
	`targetDate` text,
	`isActive` integer DEFAULT true NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`linkedAccountId`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `institutions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`simplefinOrgId` text,
	`domain` text,
	`kind` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `institutions_simplefinOrgId_unique` ON `institutions` (`simplefinOrgId`);--> statement-breakpoint
CREATE TABLE `merchant_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`normalizedMerchant` text NOT NULL,
	`categoryId` integer NOT NULL,
	`confidence` real,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_cache_normalizedMerchant_unique` ON `merchant_cache` (`normalizedMerchant`);--> statement-breakpoint
CREATE TABLE `recurring_series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payeeNormalized` text NOT NULL,
	`accountId` integer,
	`categoryId` integer,
	`cadence` text DEFAULT 'monthly' NOT NULL,
	`expectedAmountCents` integer DEFAULT 0 NOT NULL,
	`lastAmountCents` integer DEFAULT 0 NOT NULL,
	`lastSeenAt` integer,
	`nextExpectedAt` integer,
	`occurrences` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`accountId`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_payee_account_uq` ON `recurring_series` (`payeeNormalized`,`accountId`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`accountId` integer NOT NULL,
	`externalId` text,
	`postedAt` integer NOT NULL,
	`amountCents` integer NOT NULL,
	`merchantRaw` text DEFAULT '' NOT NULL,
	`payeeNormalized` text DEFAULT '' NOT NULL,
	`memo` text,
	`note` text,
	`categoryId` integer,
	`categorySource` text DEFAULT 'uncategorized' NOT NULL,
	`categoryConfidence` real,
	`isPending` integer DEFAULT false NOT NULL,
	`isRecurring` integer DEFAULT false NOT NULL,
	`isTransfer` integer DEFAULT false NOT NULL,
	`recurringSeriesId` integer,
	`source` text DEFAULT 'manual' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`accountId`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tx_posted_idx` ON `transactions` (`postedAt`);--> statement-breakpoint
CREATE INDEX `tx_account_idx` ON `transactions` (`accountId`);--> statement-breakpoint
CREATE INDEX `tx_category_idx` ON `transactions` (`categoryId`);--> statement-breakpoint
CREATE INDEX `tx_payee_idx` ON `transactions` (`payeeNormalized`);--> statement-breakpoint
CREATE UNIQUE INDEX `tx_account_external_uq` ON `transactions` (`accountId`,`externalId`);