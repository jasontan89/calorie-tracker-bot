-- Version 3.6 Migration: Telegram Webhook Deduplication Table
-- Stores recent update_ids to prevent retry loops from flooding users with duplicate messages

CREATE TABLE IF NOT EXISTS public.processed_updates (
  update_id bigint PRIMARY KEY,
  created_at timestamp with time zone DEFAULT now()
);

-- Index on created_at for fast cleanup
CREATE INDEX IF NOT EXISTS idx_processed_updates_created 
  ON public.processed_updates (created_at);

-- Allow service role full access
ALTER TABLE public.processed_updates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for service role" ON public.processed_updates;
CREATE POLICY "Allow all for service role" 
  ON public.processed_updates TO service_role USING (true) WITH CHECK (true);
