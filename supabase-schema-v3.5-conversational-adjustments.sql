-- Version 3.5 Database Migration: Active Adjustment Sessions
-- Adds active_adjustment JSONB column to user_profiles for conversational meal tweaks

ALTER TABLE public.user_profiles 
  ADD COLUMN IF NOT EXISTS active_adjustment jsonb DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_active_adj 
  ON public.user_profiles (user_id) 
  WHERE active_adjustment IS NOT NULL;
