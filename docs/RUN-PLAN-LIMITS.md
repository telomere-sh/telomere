# Run-plan policy feedback

Configure a cell shows the current CPU time maximum from the server's public
configuration and the selected Leash's hourly/daily limits, allowed hardware,
expiry in UTC, and sealed-host requirement. The same configured maximum bounds
the subsequent CPU task review. No policy or execution limit is changed.

Inline errors identify Maximum minutes, Planning rate, Spending ceiling,
Hardware class, Lane or Leash policy. They refresh as values or policy selection
change, associate with controls and mobile picker proxies, and focus the first
invalid field on submission. Unknown attached policies fail explicitly. A draft
without an attached policy can still be saved; execution requires an active one.

For the reported policy (0.01 USDC hourly, 0.05 daily), 50 minutes at a planning
rate of 1 USDC/hour and a 5-USDC ceiling report separate duration and spending
issues. A one-minute plan at 0.36 USDC/hour with a 0.01 ceiling fits these planning
limits. Its estimate is shown as 0.00654 USDC, retaining the existing standard-lane
planning allowance. A fresh signed quote still determines the actual reservation.

The form preserves explicit values in existing/duplicate plans so a duration
above the current cap is explained rather than silently truncated. New defaults
fit the configured CPU maximum. Saved numeric fields remain compatible with the
workspace schema. Ceiling precision is checked against six-decimal USDC execution
support. The CPU review uses integer seconds within the configured limit.

The pure policy module is covered by boundary tests, including different runtime
duration caps, missing limits, policy changes, expiry/revocation, hardware/sealed
restrictions, remaining workspace budget, precision, and amounts at policy caps.
Browser verification uses isolated loopback fixtures with synthetic accounts,
120/90-second configurations and policies. Only fixture workspace metadata can
be written; signature and financial endpoints are disabled. Production wallet
signatures and payments are not repeated to verify a form change.

Previous frontend sources remain archived in
`evidence/plan-limits-20261112/frontend-source.json` and are hash-checked alongside
the current approved files. A separate static reviewer checks the drawer and
helper integration. Calibration uses one deliberately incorrect CPU maximum in a
temporary Git worktree; this proves detection of an incorrect metadata source,
not rendering, persistence, wallet behavior or contract enforcement.
