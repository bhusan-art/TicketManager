CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"voucher_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"paid_on" date NOT NULL,
	"mode" text NOT NULL,
	"reference" text,
	"note" text,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversal_reason" text,
	CONSTRAINT "payments_number_unique" UNIQUE("number"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_paise" > 0),
	CONSTRAINT "payments_reversal_complete" CHECK (("payments"."reversed_at" is null) = ("payments"."reversed_by" is null) and ("payments"."reversed_at" is null) = ("payments"."reversal_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "paid_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_voucher_idx" ON "payments" USING btree ("voucher_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_paid_on_idx" ON "payments" USING btree ("paid_on");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_reference_active_key" ON "payments" USING btree ("mode","reference") WHERE "payments"."reversed_at" is null and "payments"."reference" is not null;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_paid_within_approved" CHECK ("vouchers"."paid_paise" >= 0 and "vouchers"."paid_paise" <= coalesce("vouchers"."approved_total_paise", 0));