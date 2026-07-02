---
title: "Postgres slow query — missing index"
lang: en
tags: [code]
---

The account activity page was taking ~4 seconds to load. Traced it to one query
on the `orders` table filtering by customer and a date range:

```sql
SELECT * FROM orders
WHERE customer_id = $1
  AND created_at >= $2
ORDER BY created_at DESC;
```

`EXPLAIN ANALYZE` showed a sequential scan over 2.1M rows — 4.2s. There was an
index on `customer_id` alone but nothing that helped the `created_at` sort, so
Postgres scanned every order for that customer and then sorted.

Fix: a composite index matching the filter + sort order.

```sql
CREATE INDEX idx_orders_customer_created
  ON orders (customer_id, created_at);
```

After that the same query used an index scan and came back in ~30ms. Ran the
`CREATE INDEX` with `CONCURRENTLY` in prod so it didn't lock writes. Reminder to
self: the column order in a composite index is not cosmetic — equality column
first, range/sort column second.
