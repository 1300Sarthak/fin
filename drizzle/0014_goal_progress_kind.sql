ALTER TABLE `goals` ADD `progressKind` text DEFAULT 'balance' NOT NULL;--> statement-breakpoint
ALTER TABLE `goals` ADD `taxYear` integer;--> statement-breakpoint
ALTER TABLE `goals` ADD `manualProgressCents` integer;