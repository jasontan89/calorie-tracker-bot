-- Version 3 Database Migration
-- Create table for mapping users to Telegram Groups for Leaderboards

CREATE TABLE IF NOT EXISTS public.group_members (
  group_id bigint NOT NULL,
  user_id bigint NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  joined_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

-- Enable RLS
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
DROP POLICY IF EXISTS "Allow all operations for service role" ON public.group_members;
CREATE POLICY "Allow all operations for service role" ON public.group_members TO service_role USING (true) WITH CHECK (true);
