# 11. Host revenue calculator

Prepared locally behind `POSTLAUNCH_FEATURES=host-calculator`. `/hosts/calculator/` models revenue for a chosen USDC hourly or per-second price, paid hours per day (0-24), period (1-366 days) and standard 9% / sealed 12% fee scenario. These are explicit modeling assumptions, not the current direct CPU settlement fee or a promise of hardware utilization, guaranteed earnings or available GPU capacity.

All calculations use integer atomic amounts. Each day's gross revenue rounds down and modeled fee rounds up; the period sums those daily-rounded figures. Inputs remain editable; changed input clears obsolete results and field-specific errors explain corrections. Calculation performs no network request, signature or payment.

Validation: 41 tests cover exact arithmetic, rounding boundaries, equivalent units, capped inputs, editable forms and clearing stale results.
