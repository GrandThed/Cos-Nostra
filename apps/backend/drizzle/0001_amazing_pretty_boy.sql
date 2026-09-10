CREATE TABLE "guild_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"seed_emojis" text DEFAULT '["🔥","😂","💀"]' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
