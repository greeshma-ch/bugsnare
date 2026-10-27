# Bugsnare evaluation

Generated 2026-10-27T13:37:51.267Z - 3 run(s) per issue, 2000ms delay between runs.

Some runs ended in an error, so this report went to eval-results.failed.md and eval-results.md was left untouched.

| issue | expected | actual | steps | seconds | tokens | pass/fail |
| --- | --- | --- | --- | --- | --- | --- |
| cart-total.md | reproduced | reproduced x3 | 3, 3, 3 | 38.0s | 4733 | 3/3 PASS |
| checkout-email.md | reproduced | reproduced, error, error | 5, 0, 0 | 99.7s | 8040 | 1/3 FAIL |
| checkout-redirect.md | reproduced | reproduced, reproduced, error | 2, 2, 0 | 87.2s | 3579 | 2/3 FAIL |
| control-two-items.md | gave_up | gave_up x3 | 2, 2, 2 | 99.1s | 4840 | 3/3 PASS |
| discount-code.md | reproduced | reproduced, gave_up, reproduced | 4, 1, 4 | 99.3s | 5106 | 2/3 FAIL |

2/5 issues matched their expectation (11/15 runs).

Run errors:
- checkout-email.md: 400 {"error":{"message":"Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.","type":"invalid_request_error","code":"json_validate_failed","failed_generation":""}}
- checkout-email.md: 400 {"error":{"message":"Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.","type":"invalid_request_error","code":"json_validate_failed","failed_generation":""}}
- checkout-redirect.md: 400 {"error":{"message":"Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.","type":"invalid_request_error","code":"json_validate_failed","failed_generation":""}}
