-- Version 3.7 Database Migration: Security & Cleanup Hardening
-- 1. Ensure foreign key constraint with cascade delete on pending_food_logs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pending_food_logs_user_id_fkey'
  ) THEN
    ALTER TABLE public.pending_food_logs
      ADD CONSTRAINT pending_food_logs_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.user_profiles(user_id) ON DELETE CASCADE;
  END IF;
END $$;

-- 2. Cleanup function to prune expired updates and stale pending logs
CREATE OR REPLACE FUNCTION public.cleanup_stale_bot_records()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Delete webhook deduplication records older than 48 hours
  DELETE FROM public.processed_updates
  WHERE created_at < NOW() - INTERVAL '48 hours';

  -- Delete abandoned pending food logs older than 48 hours
  DELETE FROM public.pending_food_logs
  WHERE created_at < NOW() - INTERVAL '48 hours';
END;
$$;
