# Public website loading

Include `static-compression.conf` in the HTTPS `telomere.sh` nginx server block,
then validate with `nginx -t` before reloading nginx. Save the previous vhost for
rollback. This affects public text assets and preserves the API's `no-store`
response policy; it introduces no shared response cache.

`website/dist/preload.js` prepares at most four visible images for at most
800 ms. It preserves responsive sources and native lazy loading, requests no
site-wide image manifest, and releases the overlay after a four-second maximum
even when route initialization fails. Fonts and off-screen images do not gate
readiness. The loading bar is indeterminate rather than a download percentage.

The native Framer animation runtime and layout are unchanged. Its CMS responses
must retain the application's concatenated `?range=` handling; do not replace
that route with a static file response or a cache that ignores query strings.

Verification: `npx vitest run tests/website-readiness.test.ts tests/website.test.ts
tests/release-info.test.ts`, `npm --prefix website run check`,
`npm run typecheck`, full build and strict release-manifest verification. Check
`Content-Encoding: gzip` and `Vary: Accept-Encoding` on a public JavaScript file,
and compare decompressed bytes with the release inventory. Test the landing,
menu and Workspace after deployment without signing a transaction.
