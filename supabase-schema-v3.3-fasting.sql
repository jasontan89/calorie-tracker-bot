-- Version 3.3 Database Migration
-- Create fasting_logs table if not exists and add completion notification tracking

CREATE TABLE IF NOT EXISTS public.fasting_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  target_hours numeric NOT NULL DEFAULT 16,
  start_time timestamp with time zone NOT NULL DEFAULT now(),
  end_time timestamp with time zone,
  status text NOT NULL DEFAULT 'active', -- 'active', 'completed', 'cancelled'
  notified_completion boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.fasting_logs ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
DROP POLICY IF EXISTS "Allow all operations for service role" ON public.fasting_logs;
CREATE POLICY "Allow all operations for service role" 
  ON public.fasting_logs TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.fasting_logs 
  ADD COLUMN IF NOT EXISTS notified_completion boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_fasting_logs_active_cron 
  ON public.fasting_logs (status, start_time, target_hours) 
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_fasting_logs_user_status 
  ON public.fasting_logs (user_id, status);
