CREATE TABLE "browser_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "browser_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "participants" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "tag_voice_members" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_sessions_user_idx" ON "browser_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guild_settings_slug_idx" ON "guild_settings" USING btree ("slug");