---
title: "Regex for parsing log timestamps"
lang: en
tags: [code]
---

Keep rewriting this so I'm parking it here. Our log lines look like:

```
[2026-03-14T09:41:07Z] INFO  worker started
```

The `extractTimestamp` helper pulls the date and time out separately so I can
group by day without a full Date parse:

```js
function extractTimestamp(line) {
  const m = /^\[(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(line);
  return m ? { date: m[1], time: m[2] } : null;
}
```

Notes:
- The anchor `^\[` matters — without it the regex will happily match a timestamp
  buried in a message body and give you the wrong field.
- The trailing `Z` is intentionally *not* captured; some of our services log
  local time with an offset and I don't want to depend on it.
- If a line doesn't match, return `null` and let the caller decide. Don't throw —
  half our log volume is unstructured stack traces.
