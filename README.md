# TMark NSW Transport

React frontend built with Webpack and a built-in Node.js API server for Transport for NSW car park occupancy.

```
tmark-nsw-transport/
|-- backend/  Node.js HTTP server and API (keeps your API key off the browser)
`-- frontend/ React application and Webpack configuration
```

## Setup

Requires Node.js 18 or newer.

1. Sign up at https://opendata.transport.nsw.gov.au
2. Copy the API key
3. Install dependencies from the repository root:

   ```sh
   npm install
   ```

4. Copy `backend/.env.example` to `backend/.env` and set `TFNSW_API_KEY` to your key.

## Development
```bash
npm run dev
```
- Starts the Node.js API and Webpack file watcher together.
- Rebuilds the React bundle when frontend files change; refresh http://localhost:4000 to see updates.
- API: http://localhost:4000/api/carparks

## Production
```bash
npm start
```
- Builds the React app and serves it with the API at http://localhost:4000.

## How it works
- `GET /api/carparks` (this project) calls Transport NSW `GET /v1/carpark/full-list` with header
  `Authorization: apikey <KEY>`. Set `TFNSW_API_KEY` to either the raw token or the complete header
  value (`apikey <KEY>`). If that endpoint is unavailable it falls back to `GET /v1/carpark`
  (list) + `GET /v1/carpark?facility=<id>` (detail) for each car park.
- Availability = `spots - occupancy.total` (Transport NSW recommended calculation).
- Responses are cached for `CACHE_SECONDS` (default 30) to protect your rate limit; the UI refreshes every 300 s.
