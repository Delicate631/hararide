# Hararide: setup (about 30 minutes, all free tiers)

## 1. Database (Supabase)
1. Create a free account and project at supabase.com.
2. **Authentication > Providers > Email**: turn OFF "Confirm email" (so sign-up works instantly).
3. **SQL Editor**: paste all of `schema.sql` and click Run.
4. **Project Settings > API**: copy the Project URL and the `anon` public key.
5. Open `index.html` and replace `YOUR_SUPABASE_URL` and `YOUR_SUPABASE_ANON_KEY` near the top of the script.

## 2. Put it online (Vercel)
1. Put the `hararide` folder in a GitHub repo, or use the Vercel CLI (`npx vercel` inside the folder).
2. Import it at vercel.com (framework: "Other"). You get a link like `https://hararide.vercel.app`.

## 3. Your three links
- Passenger: `https://YOUR-SITE/#passenger`
- Driver: `https://YOUR-SITE/#driver`
- Super user: `https://YOUR-SITE/#admin`

Anyone who signs up picks passenger or driver. Each person only sees their own mode.
**Make yourself super user:** sign up normally, then run the commented line at the bottom of `schema.sql` with your email.
The 10% commission is calculated by the database whenever a ride is completed.

## 4. EcoCash payments (optional, cash works without this)
1. Register a merchant account at paynow.co.zw and create an integration.
2. In Vercel > Settings > Environment Variables add: `PAYNOW_ID`, `PAYNOW_KEY`, `SITE_URL` (your site address).
3. Redeploy. Passengers who choose EcoCash get a payment prompt after the trip. The super user taps "Mark paid" once the money arrives. Automatic confirmation needs a Paynow result webhook, which is the next step to build.

## Before real customers
- The free OpenStreetMap services (map tiles, search, route calculation) are for light use. At scale, switch to a paid provider such as Mapbox or Google, or host your own.
- Check Zimbabwe licensing and insurance rules for ride-hailing, and verify drivers (ID, licence, vehicle).
- The profiles table lets signed-in users read names and phone numbers. Tighten this policy before launch.
- Test everything with real phones and small amounts first.

## Update: ratings and automatic EcoCash confirmation
1. Run `schema_update.sql` in the Supabase SQL Editor (adds ratings). Passengers rate drivers after a trip; drivers see their average.
2. In Vercel add two more variables: `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (Supabase > Project Settings > API, the `service_role` key). Keep that key secret and never put it in index.html.
3. Redeploy. EcoCash rides now become "paid" automatically when Paynow confirms. "Mark paid" stays as a backup.
