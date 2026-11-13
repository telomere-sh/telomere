# 05. Editable Leash presets

Prepared locally behind `POSTLAUNCH_FEATURES=leash-presets`. Conservative (0.1/hour, 1/day), Standard (1/hour, 10/day) and Selection-max (20/hour, 200/day) fill only spending fields. Expiry, agent, hardware and sealing remain untouched. Values stay editable; saving still requires the normal separate wallet confirmation. Presets never request signatures or transactions.

Both fields are validated atomically against configured conservative caps and native input constraints before either is changed. Selection-max is a preset name, not creation of a Selection Vault. Existing policies remain available when this update is disabled.

Validation: 37 focused tests covering exact decimal arithmetic, caps, native validation, preserved inputs, input events and no submission.
