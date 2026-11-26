CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "document_counters" (
	"kind" text NOT NULL,
	"year" integer NOT NULL,
	"last_value" integer NOT NULL,
	CONSTRAINT "document_counters_kind_year_pk" PRIMARY KEY("kind","year")
);
--> statement-breakpoint
CREATE TABLE "voucher_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_attachments_file_id_unique" UNIQUE("file_id")
);
--> statement-breakpoint
CREATE TABLE "voucher_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"category_id" uuid,
	"expense_date" date,
	"description" text,
	"vendor_name" text,
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"is_gst" boolean DEFAULT false NOT NULL,
	"gstin" text,
	"invoice_number" text,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"missing_proof_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_lines_amounts_non_negative" CHECK ("voucher_lines"."amount_paise" >= 0 and "voucher_lines"."cgst_paise" >= 0 and "voucher_lines"."sgst_paise" >= 0 and "voucher_lines"."igst_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text,
	"employee_id" uuid NOT NULL,
	"department_id" uuid,
	"manager_id" uuid,
	"purpose" text,
	"approval_status" text DEFAULT 'draft' NOT NULL,
	"payment_status" text DEFAULT 'not_due' NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone,
	"accounts_review_started_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vouchers_number_unique" UNIQUE("number"),
	CONSTRAINT "vouchers_total_non_negative" CHECK ("vouchers"."total_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "voucher_attachments" ADD CONSTRAINT "voucher_attachments_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_attachments" ADD CONSTRAINT "voucher_attachments_line_id_voucher_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."voucher_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_attachments" ADD CONSTRAINT "voucher_attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_lines" ADD CONSTRAINT "voucher_lines_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_lines" ADD CONSTRAINT "voucher_lines_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voucher_attachments_line_idx" ON "voucher_attachments" USING btree ("line_id");--> statement-breakpoint
CREATE INDEX "voucher_lines_voucher_idx" ON "voucher_lines" USING btree ("voucher_id","position");--> statement-breakpoint
CREATE INDEX "vouchers_employee_idx" ON "vouchers" USING btree ("employee_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "vouchers_status_idx" ON "vouchers" USING btree ("approval_status");--> statement-breakpoint
-- Removing an attachment (directly, or with its line or voucher) also removes the stored file.
CREATE FUNCTION voucher_attachment_delete_file() RETURNS trigger AS $$
BEGIN
  DELETE FROM files WHERE id = OLD.file_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER voucher_attachments_delete_file
  AFTER DELETE ON voucher_attachments
  FOR EACH ROW EXECUTE FUNCTION voucher_attachment_delete_file();--> statement-breakpoint
-- Starting categories. Admins can rename, add or deactivate them.
INSERT INTO categories (name, description) VALUES
  ('Travel', 'Air, rail and bus tickets, cabs between cities'),
  ('Local conveyance', 'Auto, cab, metro and fuel within the city'),
  ('Accommodation', 'Hotel and guest house stays'),
  ('Food and meals', 'Meals while travelling or with clients'),
  ('Client meeting', 'Client entertainment and meeting costs'),
  ('Office supplies', 'Stationery and small office purchases'),
  ('Communication', 'Phone, data and courier'),
  ('Other', 'Anything that does not fit another category');
