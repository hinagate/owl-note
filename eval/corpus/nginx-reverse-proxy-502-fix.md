---
title: "Nginx reverse proxy 502 fix"
lang: en
tags: [code]
---

# 502 Bad Gateway on large uploads

Uploads over ~5 MB were failing with a 502. The app upstream (gunicorn on
127.0.0.1:8080) was fine — nginx was cutting the connection before the backend
finished writing the response.

Two things were wrong:

- Default `client_max_body_size` is 1m, so nginx rejected the body outright on
  bigger files.
- On the slow requests that *did* get through, `proxy_read_timeout` (default 60s)
  fired mid-response.

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8080;
    client_max_body_size 50m;
    proxy_read_timeout 300s;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

Bumped the body size to 50m and the read timeout to 300s, then `nginx -t` to
check the config and `systemctl reload nginx`. No more 502s. If it comes back,
check the gunicorn worker timeout too — it has its own 30s default.
