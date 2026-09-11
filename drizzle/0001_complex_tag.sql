CREATE TABLE `goal_accounts` (
	`goalId` integer NOT NULL,
	`accountId` integer NOT NULL,
	PRIMARY KEY(`goalId`, `accountId`),
	FOREIGN KEY (`goalId`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`accountId`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `goal_accounts_goal_idx` ON `goal_accounts` (`goalId`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `sortOrder` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `goals` ADD `parentGoalId` integer;