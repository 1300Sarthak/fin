ALTER TABLE `transactions` ADD `transferPairTxnId` integer;
--> statement-breakpoint
CREATE INDEX `tx_transfer_pair_idx` ON `transactions` (`transferPairTxnId`);
