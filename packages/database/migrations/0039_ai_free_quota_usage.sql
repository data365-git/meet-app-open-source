CREATE TABLE `ai_free_quota_usage` (
	`dayPt` varchar(10) NOT NULL,
	`model` varchar(96) NOT NULL,
	`requests` int NOT NULL DEFAULT 0,
	`dailyExhaustedAt` datetime,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `ai_free_quota_usage_dayPt_model_pk` PRIMARY KEY(`dayPt`,`model`)
);
