CREATE TABLE "voucher_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"voucher_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_role" text,
	"type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"message" text,
	"meta" jsonb
);
--> statement-breakpoint
ALTER TABLE "voucher_lines" ADD COLUMN "approved_paise" bigint;--> statement-breakpoint
ALTER TABLE "voucher_lines" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "approved_total_paise" bigint;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voucher_events" ADD CONSTRAINT "voucher_events_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_events" ADD CONSTRAINT "voucher_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voucher_events_voucher_idx" ON "voucher_events" USING btree ("voucher_id","id");--> statement-breakpoint
CREATE INDEX "voucher_events_actor_idx" ON "voucher_events" USING btree ("actor_id","type");--> statement-breakpoint
ALTER TABLE "voucher_lines" ADD CONSTRAINT "voucher_lines_approved_within_claim" CHECK ("voucher_lines"."approved_paise" is null or ("voucher_lines"."approved_paise" >= 0 and "voucher_lines"."approved_paise" <= "voucher_lines"."amount_paise"));--> statement-breakpoint
-- Timeline entries for vouchers created before the timeline existed.
INSERT INTO voucher_events (voucher_id, at, actor_id, type, to_status)
  SELECT id, created_at, employee_id, 'created', 'draft' FROM vouchers;--> statement-breakpoint
INSERT INTO voucher_events (voucher_id, at, actor_id, type, from_status, to_status)
  SELECT id, submitted_at, employee_id, 'submitted', 'draft',
    CASE WHEN approval_status = 'cancelled' THEN 'pending_manager' ELSE approval_status END
  FROM vouchers WHERE submitted_at IS NOT NULL;--> statement-breakpoint
INSERT INTO voucher_events (voucher_id, at, actor_id, type, to_status, message)
  SELECT id, cancelled_at, employee_id, 'cancelled', 'cancelled', cancel_reason
  FROM vouchers WHERE cancelled_at IS NOT NULL;
