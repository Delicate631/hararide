-- Run in Supabase SQL Editor after schema.sql (adds driver ratings)
alter table rides add column rating int check(rating between 1 and 5);
