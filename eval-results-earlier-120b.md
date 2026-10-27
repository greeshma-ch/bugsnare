# Bugsnare evaluation

Generated 2026-10-27T06:56:32.274Z - 3 run(s) per issue, 2000ms delay between runs.

| issue | expected | actual | steps | seconds | tokens | pass/fail |
| --- | --- | --- | --- | --- | --- | --- |
| cart-total.md | reproduced | reproduced x3 | 3, 3, 2 | 7.7s | 2663 | 3/3 PASS |
| checkout-email.md | reproduced | reproduced x3 | 3, 2, 2 | 21.2s | 2173 | 3/3 PASS |
| checkout-redirect.md | reproduced | reproduced x3 | 5, 2, 2 | 48.7s | 2875 | 3/3 PASS |
| control-two-items.md | gave_up | gave_up x3 | 2, 2, 2 | 42.5s | 2995 | 3/3 PASS |
| discount-code.md | reproduced | reproduced x3 | 3, 3, 3 | 36.8s | 3067 | 3/3 PASS |

5/5 issues matched their expectation (15/15 runs).
