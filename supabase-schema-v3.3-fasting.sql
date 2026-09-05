-- Version 3.3 Database Migration
-- Add completion notification tracking and performance index to fasting_logs

ALTER TABLE public.fasting_logs 
  ADD COLUMN IF NOT EXISTS notified_completion boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_fasting_logs_active_cron 
  ON public.fasting_logs (status, start_time, target_hours) 
  WHERE status = 'active';
