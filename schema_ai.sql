-- Run once in Supabase > SQL Editor (after schema_verify.sql). Stores the AI document check result.
alter table driver_docs add column ai_status text, add column ai_report jsonb, add column ai_checked_at timestamptz;
