-- Version 3.2 Database Migration
-- Add user names for group leaderboards, meal_type for food logs, and editing state for pending logs

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS editing_pending_id uuid;

ALTER TABLE public.food_logs
  ADD COLUMN IF NOT EXISTS meal_type text DEFAULT 'Snack';

ALTER TABLE public.pending_food_logs
  ADD COLUMN IF NOT EXISTS meal_type text DEFAULT 'Snack';
