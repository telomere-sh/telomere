Historical source byte archive

The manifest binds each retained historical source record to its original paths, sizes and SHA-256 values. Unchanged source bytes are verified directly in the checkout. Historical versions that differ from the checkout are stored as content-addressed .bin objects. These are raw file bytes, not Git objects or executable release packages.

The verifier pins the complete manifest, requires every stored path to be tracked, compares each entry to the original evidence record and verifies the bytes. The original website JavaScript and its approved current social-link edit are checked independently. No former commit, remote, branch, or personal author metadata is required.

Run from the repository root: python -B docs/verify-evidence.py
