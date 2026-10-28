# TMark NSW Transport

React frontend and Node.js server for live NSW train-station car park occupancy. The server replaces the supplied n8n workflow: it fetches the seven configured TfNSW facilities, transforms their occupancy data, and upserts it into Supabase. The website reads the stored rows through the server API.

## Setup

Requires Node.js 18 or newer.

1. Create or open the Supabase project at `https://iaqwzvnjpfdojnbrlgpz.supabase.co`.
2. In the Supabase SQL Editor, run [`backend/schema.sql`](./backend/schema.sql) to create `public.car_spots`.
3. Create a Transport for NSW API key at https://opendata.transport.nsw.gov.au.
4. Copy [`backend/.env.example`](./backend/.env.example) to `backend/.env`, then set:
   - `TFNSW_API_KEY` to your Transport for NSW key.
   - `SUPABASE_SECRET_KEY` to a Supabase server-side secret key from the project's API settings. A legacy `service_role` JWT can also be configured under `SUPABASE_SERVICE_ROLE_KEY`.
   - `SUPABASE_URL` if your project URL differs from the configured project.
5. Install dependencies from the repository root:

   ```sh
   npm install
   ```
6. Build the frontend once, and again whenever frontend source files change:

   ```sh
   npm run build
   ```

## Development

```sh
npm run dev
```

Starts the server at http://localhost:4000 without rebuilding the frontend. Run `npm run build` separately after changing frontend source files.

## Production

```sh
npm start
```

Starts the server without rebuilding the frontend. Build the frontend separately before the first start and whenever frontend source files change.

## Data flow

- On server start, the backend requests TfNSW facilities `24`, `26`, `27`, `28`, `29`, `30`, and `31`. It prefers TfNSW's consolidated full-list endpoint (one request per sync); if unavailable, it requests facilities one at a time with a delay. Subsequent sync intervals are configured by hour in [`backend/adaptive-delay.json`](./backend/adaptive-delay.json), using the configured timezone and delay in seconds. The default Sydney-time cadence is every 25 seconds from 5–10 am and 2–6 pm, every 40 seconds from 10 am–2 pm, every 2 minutes from 6–8 pm, and every 3 minutes otherwise. The windows must be ordered, contiguous, and cover all 24 hours.
- It maps facility details and occupancy into `public.car_spots`, calculates `available` as `total_spots - occupied`, and upserts by `id`.
- TfNSW `429` responses are handled with exponential backoff (starting at five minutes and capped at six hours), honoring `Retry-After` when the API supplies it. Scheduled and manual syncs wait until the backoff expires.
- `GET /api/carparks` reads the current rows from Supabase, including suburb and address for display and search. `POST /api/carparks/sync` runs an immediate sync and returns the refreshed rows; the website's **Refresh** button uses this endpoint.
- The Supabase secret/service-role key is used only by the backend. Do not put it in frontend code or commit `backend/.env`.
