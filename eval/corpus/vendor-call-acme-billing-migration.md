---
title: "Vendor call: Acme billing migration"
lang: en
tags: [meeting]
---

# Acme billing migration — vendor call, 19 March 2026

Us: Priya, Sam. Them: their account rep and a solutions engineer.

The plan for moving off the old billing system onto Acme:
- **Cutover date: 30 April.** We run both systems in parallel ("dual-run") for
  two weeks after, reconciling invoices daily, before we shut the old one off.
- Acme will send us **sandbox credentials by 25 March** so we can build and test
  the integration against their staging environment first.
- They handle the historical invoice import; we own the webhook that syncs new
  charges.

Risks flagged: their sandbox is a shared environment, so test data can get wiped
without warning — don't rely on anything persisting there. Sam to own the
integration; Priya to keep finance in the loop on the cutover date.
