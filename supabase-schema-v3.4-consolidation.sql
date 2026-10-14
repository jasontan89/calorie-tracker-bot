-- Version 3.4 Database Migration & Performance Consolidation
-- Adds missing columns (persona, logging_mode, items, barcode) and performance indexes

-- 1. User Profiles: persona & logging_mode
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS persona text NOT NULL DEFAULT 'sarcastic',
  ADD COLUMN IF NOT EXISTS logging_mode text NOT NULL DEFAULT 'itemized';

-- 2. Pending Food Logs: items JSONB for multi-item meal recognition
ALTER TABLE public.pending_food_logs
  ADD COLUMN IF NOT EXISTS items jsonb;

-- 3. Confirmed Food Logs: barcode tracking
ALTER TABLE public.food_logs
  ADD COLUMN IF NOT EXISTS barcode text;

-- 4. Foreign Key on food_logs if not already defined
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'food_logs_user_id_fkey'
  ) THEN
    ALTER TABLE public.food_logs
      ADD CONSTRAINT food_logs_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.user_profiles(user_id) ON DELETE CASCADE;
  END IF;
END $$;

-- 5. Performance Indexes for high-frequency queries
CREATE INDEX IF NOT EXISTS idx_food_logs_user_created 
  ON public.food_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_weight_logs_user_created 
  ON public.weight_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_presets_user 
  ON public.user_presets (user_id);

CREATE INDEX IF NOT EXISTS idx_group_members_user 
  ON public.group_members (user_id);

CREATE INDEX IF NOT EXISTS idx_pending_food_logs_user 
  ON public.pending_food_logs (user_id);
