# Demo corpus for Ask Owl

A tiny, invented note set (10 English + 2 Japanese) for trying Ask Owl — no real
people, no personal data, nothing copyrighted.

**Load it:** open OWL-Note → **Import** → select `demo-notes.json`.

**Then open Ask Owl and try:**

1. **"What do I pay for housing?"** — the budget note only ever says *"Rent:
   $1,400"* (never "housing" or "pay"), so keyword search misses it. Build the
   semantic index first (one-time on-device download) to watch it land — this is
   the paraphrase money-shot.
2. **"What temperature do I bake the focaccia at?"** — a direct question; the
   answer cites the recipe, and the citation jumps straight to it.
3. **「エクスポート機能はいつリリースしますか?」** — a multilingual (CJK) beat:
   the answer comes from the Japanese standup note (金曜日 / Friday).
4. **"How many cores does my Apple have?"** — the disambiguation demo. Two notes
   deliberately share the words *apple, core, skin, crisp, juice* — but one is a
   dessert recipe and one is a laptop checklist. Keyword search can't tell them
   apart; Ask Owl answers "10" from the laptop note. Then ask **"What oven
   temperature for the apple dessert?"** and it switches to the recipe (190°C) —
   same vocabulary, opposite meaning, correct note both times.
