-- Upgrade user_profiles to support custom macro targets, reminders, and streaks
ALTER TABLE public.user_profiles 
  ADD COLUMN IF NOT EXISTS target_protein integer, -- optional, if null we calculate dynamically
  ADD COLUMN IF NOT EXISTS target_carbs integer,
  ADD COLUMN IF NOT EXISTS target_fat integer,
  ADD COLUMN IF NOT EXISTS reminders_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS streak_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_log_date date;

-- Upgrade food logs to capture macros
ALTER TABLE public.food_logs 
  ADD COLUMN IF NOT EXISTS protein integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS carbs integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fat integer NOT NULL DEFAULT 0;

ALTER TABLE public.pending_food_logs 
  ADD COLUMN IF NOT EXISTS protein integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS carbs integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fat integer NOT NULL DEFAULT 0;

-- Create weight logs table
CREATE TABLE IF NOT EXISTS public.weight_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  weight numeric(5,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

-- Enable RLS for weight_logs
ALTER TABLE public.weight_logs ENABLE ROW LEVEL SECURITY;

-- Service Role policies to allow all actions for the edge function
CREATE POLICY "Allow all operations for service role" 
ON public.weight_logs TO service_role USING (true) WITH CHECK (true);
