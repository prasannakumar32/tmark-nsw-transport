# TMark NSW Transport

The application is split into three independently deployable parts:

1. **Workflow** (`backend/workflow/`) — reads live parking occupancy from TfNSW, transforms it, and upserts it to Supabase on the configured schedule.
2. **API** (`backend/api/`) — reads the saved data from Supabase and exposes JSON endpoints.
3. **Frontend** — a static React site that calls the REST API. It can be hosted on any static hosting provider.

The data path is **TfNSW → workflow → Supabase → API → frontend**. The workflow does not serve API requests or web files; the API does not run the sync process; and the frontend contains no Supabase or TfNSW credentials. Shared backend configuration and Supabase helpers live in `backend/shared/`.

Requires Node.js 18 or newer.

## Local setup

1. Create or open the Supabase project at `https://iaqwzvnjpfdojnbrlgpz.supabase.co`.
2. Ensure the project has a `public.car_spots` table with the columns `id`, `facility_id`, `facility_name`, `suburb`, `address`, `total_spots`, `occupied`, `available`, `message_date`, and `updated_at`.
3. Create a Transport for NSW API key at https://opendata.transport.nsw.gov.au.
4. Copy [`backend/.env.example`](./backend/.env.example) to `backend/.env` and set `TFNSW_API_KEY` and `SUPABASE_SECRET_KEY`. The local file can configure both backend processes; in production configure each service's variables separately.
5. Install dependencies from the repository root:

   ```sh
   npm install
   ```
6. Build the frontend bundle:

   ```sh
   npm run build
   ```

Run each service in a separate terminal:

```sh
npm run dev:worker
npm run dev:api
npm run dev:frontend
```

The API listens on `http://localhost:4000`; the static frontend serves the built files on `http://localhost:9000`. The frontend development command builds once before serving, so rebuild with `npm run build` after frontend changes. The workflow performs an initial sync on startup and then follows the schedule in [`backend/workflow/adaptive-delay.json`](./backend/workflow/adaptive-delay.json).

## Production build and deployment

Build the static frontend with the public URL of the deployed REST API:

```powershell
$env:API_BASE_URL = "https://api.example.com"
npm run build
```

Deploy `frontend/dist` to a static hosting provider. `API_BASE_URL` is embedded in the frontend bundle at build time and must be an API origin, without a trailing slash. If the frontend and API are on the same origin behind a reverse proxy, it can be set to an empty string so requests use `/api`.

Deploy the backend as two separate Node.js processes using the repository root:

```sh
npm run start:api
npm run start:worker
```

Configure these environment variables on the **API** service:

- `SUPABASE_URL` (optional; defaults to the project URL in this repository)
- `SUPABASE_SECRET_KEY` (or legacy `SUPABASE_SERVICE_ROLE_KEY`)
- `API_PORT` (optional; defaults to `4000`; `PORT` is also accepted)
- `CORS_ORIGIN` — comma-separated allowed frontend origins, for example `https://dashboard.example.com`

Configure these on the **worker** service:

- `TFNSW_API_KEY`
- `TFNSW_BASE_URL` (optional; defaults to the TfNSW API URL)
- `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`)

Keep the Supabase key server-side; never add it to frontend build variables. Run exactly one worker instance to avoid duplicate TfNSW polling. Use the platform's process manager to restart it if it exits.

## REST endpoints

- `GET /api/carparks` — current car park rows and `fetchedAt` timestamp.
- `GET /api/health` — API process health.

The API allows browser access only from the origins configured by `CORS_ORIGIN`. Its local default is `http://localhost:9000,http://127.0.0.1:9000`.

## Workflow behavior

- On startup, the workflow requests TfNSW facilities `24`, `26`, `27`, `28`, `29`, `30`, and `31`. It prefers the consolidated full-list endpoint and falls back to spaced individual requests if needed.
- The default Sydney-time schedule is every 25 seconds from 5–10 am and 2–6 pm, every 40 seconds from 10 am–2 pm, every 2 minutes from 6–8 pm, and every 3 minutes otherwise. Schedule windows must be ordered, contiguous, and cover all 24 hours.
- TfNSW `429` responses use exponential backoff from five minutes up to six hours, honoring `Retry-After` when supplied. Monitor workflow logs for sync attempts and failures.
- The REST API reads Supabase directly; the frontend refreshes the API data automatically.

The Supabase secret/service-role key is used only by the backend. Do not commit `backend/.env`.
