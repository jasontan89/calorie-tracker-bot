-- Version 3.1 Database Migration
-- Create table for storing user saved food presets & supplements

CREATE TABLE IF NOT EXISTS public.user_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  food_name text NOT NULL,
  calories integer NOT NULL DEFAULT 0,
  protein integer NOT NULL DEFAULT 0,
  carbs integer NOT NULL DEFAULT 0,
  fat integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.user_presets ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
DROP POLICY IF EXISTS "Allow all operations for service role" ON public.user_presets;
CREATE POLICY "Allow all operations for service role" ON public.user_presets TO service_role USING (true) WITH CHECK (true);
