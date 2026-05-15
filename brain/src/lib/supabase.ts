import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
    'Copy .env.example to .env.local and fill in your Supabase credentials.'
  );
}

// service_role bypasses RLS — only use server-side, never expose to clients
export const supabase = createClient(url, key, {
  auth: { persistSession: false }
});
