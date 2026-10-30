-- IF NOT EXISTS, for the reason spelled out in 0003.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "degree_program" text;
