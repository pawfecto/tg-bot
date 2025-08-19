import { createClient } from '@supabase/supabase-js';
import { ENV } from '../config/env';

export const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false }
});
