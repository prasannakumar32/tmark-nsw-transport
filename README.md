# TMark NSW Transport

React frontend and a built-in Node.js HTTP server for Transport for NSW Park&Ride occupancy.

```
tmark-nsw-transport/
|-- backend/  Node.js HTTP server and API (keeps your API key off the browser)
`-- frontend/ React UI and styles
```

##  Get an API key
1. Sign up at https://opendata.transport.nsw.gov.au
3. Copy the API key

npm run install:all
cp backend/.env.example backend/.env   # Windows: copy backend\.env.example backend\.env

# edit backend/.env and set TFNSW_API_KEY=... apikey  + "url"
```

The browser entry document provides the React mount point and loads the locally installed React runtime; the UI is rendered by React.

## 3. Run (development)
```bash
npm run dev
```
- Starts the Node.js server, which serves both the React UI and API.
- UI: http://localhost:4000
- API: http://localhost:4000/api/carparks

## 4. Run (production, single server)
```bash
npm start        # Node.js serves the React frontend and API on http://localhost:4000
```

## How it works
- `GET /api/carparks` (this project) calls Transport NSW `GET /v1/carpark/full-list` with header
  `Authorization: apikey <KEY>`. Set `TFNSW_API_KEY` to either the raw token or the complete header
  value (`apikey <KEY>`). If that endpoint is unavailable it falls back to `GET /v1/carpark`
  (list) + `GET /v1/carpark?facility=<id>` (detail) for each car park.
- Availability = `spots - occupancy.total` (Transport NSW recommended calculation).
- Responses are cached for `CACHE_SECONDS` (default 30) to protect your rate limit; the UI refreshes every 300 s.
