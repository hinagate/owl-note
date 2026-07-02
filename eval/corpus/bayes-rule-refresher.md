---
title: "Bayes rule refresher for the spam filter"
lang: en
tags: [math]
---

Kept getting the direction of the conditional backwards, so: the whole thing is
just

$$P(S \mid W) = \frac{P(W \mid S)\,P(S)}{P(W)}$$

Read it as: the probability an email is spam *given* it contains a word, in terms
of how often spam contains that word.

Toy example for the filter. Say the base rate of spam is $P(S) = 0.2$. The word
"free" shows up in 60% of spam, $P(W \mid S) = 0.6$, and in 10% of real mail, so

$$P(W) = 0.6 \times 0.2 + 0.1 \times 0.8 = 0.2$$

Then $P(S \mid W) = \dfrac{0.6 \times 0.2}{0.2} = 0.6$. Seeing "free" bumps a
message from a 20% prior to a 60% posterior. Chain several independent words
(the naive-Bayes assumption) and the evidence multiplies. It's a lie that the
words are independent, but it's a *useful* lie.
