CREATE TABLE "backup_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"file" text,
	"size_bytes" bigint,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "backup_runs_finished_at_idx" ON "backup_runs" USING btree ("finished_at" DESC NULLS LAST);