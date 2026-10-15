# API

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/login` | – | `{ email, password }` → sets the `sid` session cookie (httpOnly), returns `{ user }` |
| POST | `/auth/logout` | cookie | Ends the session |
| POST | `/users` | – | Register `{ email, password, name }` |
| GET | `/users/me` | cookie | Current user |
| GET | `/products?q=` | – | List or search products |
| GET | `/products/:id` | – | One product |
| GET | `/cart` | cookie | Cart with subtotal, discount, tax and total |
| POST | `/cart/items` | cookie | `{ productId, quantity }` |
| DELETE | `/cart/items/:productId` | cookie | Remove a line |
| POST | `/cart/discount` | cookie | `{ code }` |
| POST | `/orders` | cookie | `{ cardToken }` → places an order from the cart |
| GET | `/orders/:id` | cookie | One of your orders |
