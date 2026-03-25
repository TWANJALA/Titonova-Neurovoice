# TitoNova Book Engine (MVP starter)

React + Vite frontend with an Express backend that calls OpenAI to draft a book outline and first chapter.

## Setup

1) Backend
- cd backend
- cp .env.example .env and set OPENAI_API_KEY
- npm install
- npm run dev

2) Frontend
- cd frontend
- npm install
- npm run dev

The Vite dev server proxies /api to http://localhost:5000.

## Endpoints
- POST /api/generate { prompt }: returns { text }
- POST /api/generate/stream { prompt }: streams plain text chunks for live UI updates
- POST /api/transform/stream { text, mode }: streams edited text for modes rewrite | expand | shorten | add_dialogue | make_emotional
- POST /api/voice-book (multipart form-data: file): transcribes audio via Whisper and returns structured book JSON
- POST /api/cover { prompt }: generates a book cover image (base64 data URL)
- POST /api/exports { bookId, type: pdf|docx }: enqueues an export record (plan gated)
- POST /api/exports/:id/render { content, title? }: renders PDF, stores in Supabase storage, returns signed URL (plan gated)
- GET /api/memory (auth): returns saved narrative memory JSON
- PUT /api/memory { payload } (auth): stores narrative memory JSON per user
- POST /api/stripe/create-checkout-session { priceId, successUrl, cancelUrl, userId? }: returns Stripe Checkout URL
- POST /api/stripe/portal-session { customerId, returnUrl }: returns Stripe billing portal URL
- POST /api/stripe/webhook: Stripe webhook (raw body). Handles checkout/session + subscription updates.
- GET /health: basic check
- GET /api/profile (auth required): returns current user profile (plan, stripe IDs)

## Voice to Book
- Frontend has a "Record Voice" button. It records with MediaRecorder, uploads to `/api/voice-book`, shows transcript, and fills the draft with the structured book.
- Ensure mic permissions are granted in the browser.

## Stripe Setup
- Backend env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PRO, STRIPE_PRICE_ELITE, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
- Frontend env: VITE_STRIPE_PRICE_PRO, VITE_STRIPE_PRICE_ELITE (must match backend price IDs).
- Webhook route uses raw body; keep it on a Node runtime (not edge). Map prices to plans in code (pro/elite).

## Supabase Auth
- Backend verifies Supabase JWT on protected routes (cover, voice, Stripe). Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend env.
- Frontend uses magic-link auth via supabase-js; set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in frontend env.
- Profiles table expected: `profiles(id uuid primary key, plan text default 'free', stripe_customer_id text, stripe_subscription_id text, subscription_status text, current_period_end timestamptz)`.
- Book quota: free plan allows 1 book (checked against `books.user_id`). Free plan blocks exports (placeholder for export endpoints).
