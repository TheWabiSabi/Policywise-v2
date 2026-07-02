-- Policywise Cognito profile migration
--
-- Purpose:
--   Supabase remains the application database/storage layer, but Cognito now
--   owns authentication. Keep profiles.id as the internal application user key
--   referenced by policy_analyses/chats, and store the external Cognito user id
--   in profiles.cognito_sub.
--
-- Notes:
--   - Existing profiles.id values are preserved, so existing policy/chat FKs stay
--     valid.
--   - Backfill cognito_sub by email from your Cognito export/auth service before
--     enforcing user-specific production traffic.
--   - The unique email index is intentionally not created because legacy data may
--     contain duplicates. The lookup index still makes email fallback fast.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_id_fkey;

ALTER TABLE public.profiles
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS cognito_sub text;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_cognito_sub_key
  ON public.profiles (cognito_sub)
  WHERE cognito_sub IS NOT NULL;

CREATE INDEX IF NOT EXISTS profiles_email_lower_idx
  ON public.profiles (lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS policy_analyses_user_id_idx
  ON public.policy_analyses (user_id);

CREATE INDEX IF NOT EXISTS chats_user_id_idx
  ON public.chats (user_id);

CREATE INDEX IF NOT EXISTS chats_analysis_id_idx
  ON public.chats (analysis_id);

-- Ensure FK names point to profiles, not auth.users. These are normally already
-- present in Policywise, but the guarded block repairs environments where the
-- constraint was dropped during earlier auth experiments.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'policy_analyses_user_id_fkey'
      AND conrelid = 'public.policy_analyses'::regclass
  ) THEN
    ALTER TABLE public.policy_analyses
      ADD CONSTRAINT policy_analyses_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.profiles(id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chats_user_id_fkey'
      AND conrelid = 'public.chats'::regclass
  ) THEN
    ALTER TABLE public.chats
      ADD CONSTRAINT chats_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.profiles(id)
      ON DELETE CASCADE;
  END IF;
END $$;

COMMIT;
