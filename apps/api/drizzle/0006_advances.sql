CREATE TABLE "advance_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"advance_id" uuid NOT NULL,
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
CREATE TABLE "advance_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advance_id" uuid NOT NULL,
	"kind" text NOT NULL,
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
	CONSTRAINT "advance_transactions_amount_positive" CHECK ("advance_transactions"."amount_paise" > 0),
	CONSTRAINT "advance_transactions_reversal_complete" CHECK (("advance_transactions"."reversed_at" is null) = ("advance_transactions"."reversed_by" is null) and ("advance_transactions"."reversed_at" is null) = ("advance_transactions"."reversal_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "advances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text,
	"employee_id" uuid NOT NULL,
	"department_id" uuid,
	"manager_id" uuid,
	"purpose" text NOT NULL,
	"notes" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"requested_paise" bigint NOT NULL,
	"approved_paise" bigint,
	"expected_date" date NOT NULL,
	"settle_by" date,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"disbursed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"cancel_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advances_number_unique" UNIQUE("number"),
	CONSTRAINT "advances_requested_positive" CHECK ("advances"."requested_paise" > 0),
	CONSTRAINT "advances_approved_within_requested" CHECK ("advances"."approved_paise" is null or ("advances"."approved_paise" > 0 and "advances"."approved_paise" <= "advances"."requested_paise"))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "advance_id" uuid;--> statement-breakpoint
ALTER TABLE "advance_events" ADD CONSTRAINT "advance_events_advance_id_advances_id_fk" FOREIGN KEY ("advance_id") REFERENCES "public"."advances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_events" ADD CONSTRAINT "advance_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_transactions" ADD CONSTRAINT "advance_transactions_advance_id_advances_id_fk" FOREIGN KEY ("advance_id") REFERENCES "public"."advances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_transactions" ADD CONSTRAINT "advance_transactions_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_transactions" ADD CONSTRAINT "advance_transactions_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advances" ADD CONSTRAINT "advances_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advances" ADD CONSTRAINT "advances_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advances" ADD CONSTRAINT "advances_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "advance_events_advance_idx" ON "advance_events" USING btree ("advance_id","id");--> statement-breakpoint
CREATE INDEX "advance_transactions_advance_idx" ON "advance_transactions" USING btree ("advance_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "advance_transactions_reference_active_key" ON "advance_transactions" USING btree ("mode","reference") WHERE "advance_transactions"."reversed_at" is null and "advance_transactions"."reference" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "advance_transactions_one_disbursement" ON "advance_transactions" USING btree ("advance_id") WHERE "advance_transactions"."kind" = 'disbursement' and "advance_transactions"."reversed_at" is null;--> statement-breakpoint
CREATE INDEX "advances_employee_idx" ON "advances" USING btree ("employee_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "advances_status_idx" ON "advances" USING btree ("status");--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_advance_id_advances_id_fk" FOREIGN KEY ("advance_id") REFERENCES "public"."advances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vouchers_advance_idx" ON "vouchers" USING btree ("advance_id");--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_advance_not_paid" CHECK ("vouchers"."advance_id" is null or "vouchers"."paid_paise" = 0);