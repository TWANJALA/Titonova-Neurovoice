-- Billing state table used by stripeBillingApiPlugin via SUPABASE_SERVICE_ROLE_KEY.
create table if not exists public.billing_profiles (
  uid text primary key,
  tier text not null default 'basic',
  status text not null default 'inactive',
  stripe_customer_id text,
  stripe_subscription_id text,
  last_checkout_session_id text,
  last_stripe_event_id text,
  updated_at timestamptz not null default now()
);

create index if not exists billing_profiles_stripe_customer_id_idx
  on public.billing_profiles (stripe_customer_id);
