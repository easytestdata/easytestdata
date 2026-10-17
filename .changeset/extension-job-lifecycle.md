---
"@easytestdata/server": patch
"@easytestdata/qbo-client": patch
---

Extension jobs close their sandbox target as soon as the handler settles, decide cancelled
versus failed in one database update, count sandbox activity only when a request is sent (a new `onRequestSent` QboClient option), and
replace a result only when it cannot be saved as JSON. Batch create, update and delete failures
now include QuickBooks' error `Detail`.
