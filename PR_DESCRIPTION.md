# PolicyWise Cognito/Supabase History Persistence

This PR migrates PolicyWise history persistence away from Supabase Auth assumptions and onto Cognito-backed identity. The backend now resolves each Cognito user into an internal `profiles.id` record using `cognito_sub` and normalized email, then uses that internal UUID for policy analyses, chats, and ownership checks. A Supabase migration adds `profiles.cognito_sub`, removes the old `auth.users` dependency, and keeps app data linked to `profiles(id)`.

It also restores dashboard history, historic report loading, chat persistence, and Supabase Storage-backed policy uploads through FastAPI APIs instead of direct browser-side Supabase table access. The frontend now calls the backend for client/admin history, profile updates, analysis loading, chat edits/deletes, and analysis deletion, while uploaded policy files continue to be stored in the `policy_pdfs` bucket with URLs saved in the DB.

Deployment notes: apply `migrations/001_cognito_profiles.sql`, set backend `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `AUTH_SERVICE_URL`, and Cognito env vars, then restart the backend. Verified with `python3 -m py_compile backend/main.py`, `npm run build`, and `git diff --check`.
