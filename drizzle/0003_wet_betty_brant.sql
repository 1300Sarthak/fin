ALTER TABLE `recurring_series` ADD `cancelIntent` text DEFAULT 'keep' NOT NULL;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `cancelUrl` text;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `cancelNote` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `refundsTxnId` integer;