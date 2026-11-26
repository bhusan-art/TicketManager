CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_name_unique" UNIQUE("name"),
	CONSTRAINT "projects_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "employment_type" text DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vouchers_project_idx" ON "vouchers" USING btree ("project_id");