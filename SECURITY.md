# Security policy

## Supported release

Security fixes target the latest reviewed CPU release on `main`. A public commit, a built artifact and an installed deployment are separate states. The release manifest binds artifact hashes to the reviewed commit; deployment acceptance must verify installed hashes separately.

## Private reporting

Use the repository's **Security → Report a vulnerability** form when private vulnerability reporting is enabled:

https://github.com/telomere-sh/telomere/security/advisories/new

If that form is unavailable, ask the project account at https://x.com/telomere_base to arrange a private reporting channel. Send only a request for a private contact initially. Do not post exploit details, private keys, recovery material, credentials or private user data in a public issue or social reply.

Include the affected commit, deployment/chain/address if applicable, prerequisites, impact and a minimal local reproducer using disposable accounts. A report does not require transferring real funds or testing another user's data. No bounty or response-time guarantee is implied.

## Trust boundaries

The current Base CPU escrow uses immutable quote and receipt authorities. A receipt proves a signature and can be checked against canonical settlement; it does not prove the mathematical correctness of a CPU result. The operator can read task input/output. Browser-encrypted Cyst recovery keys remain with the client.

The signer cannot withdraw an owner's unreserved available balance. A compromised receipt authority can attest false usage within accepted run ceilings. After the settlement grace period, a transaction can release an unsettled run to the payer's escrow balance; withdrawal to the wallet is separate.

Do not launch a second controller with the same production database or signer. Recovery must reconcile chain events and durable transaction bytes before compute is enabled. Operator tools reject optimized Python because integrity assertions must remain active.
