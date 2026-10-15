# shop-api

A small Express + TypeScript shop API: users, login sessions, products, cart, orders.

```bash
npm install
npm test
npm start   # http://localhost:4000
```

Money is stored in integer cents. Data lives in an in-memory store (`src/lib/db.ts`) that is seeded on start.
See `docs/API.md` for the endpoints.
