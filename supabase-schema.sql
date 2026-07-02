-- Store user targets and profiles
CREATE TABLE IF NOT EXISTS public.user_profiles (
  user_id bigint PRIMARY KEY, -- Telegram Chat/User ID
  daily_target integer NOT NULL DEFAULT 2000,
  created_at timestamp with time zone DEFAULT now()
);

-- Store logged food items
CREATE TABLE IF NOT EXISTS public.food_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL,
  food_name text NOT NULL,
  calories integer NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

-- Store temporary food logs awaiting user confirmation
CREATE TABLE IF NOT EXISTS public.pending_food_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL,
  food_name text NOT NULL,
  calories integer NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_food_logs ENABLE ROW LEVEL SECURITY;

-- Service Role (bypass RLS policies by default in Edge Functions)
-- We can also define permissive policies for testing:
CREATE POLICY "Allow all operations for service role" 
ON public.user_profiles TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations for service role" 
ON public.food_logs TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations for service role" 
ON public.pending_food_logs TO service_role USING (true) WITH CHECK (true);
