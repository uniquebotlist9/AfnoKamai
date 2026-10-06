# Optional Cloud Functions (requires Firebase Blaze plan)

The AfnoKamai app runs **entirely on the free (Spark) plan** — this folder is
NOT deployed and is not required. It contains the earlier Cloud Functions
implementation (server-side PIN verification, scheduled hold release, Brevo
email, notification fan-out).

If you ever upgrade to the Blaze plan (which has a free monthly allowance but
requires a billing account), you can re-enable this backend for stronger
server-side enforcement:

1. Move this folder back to `functions/` and restore the `functions` block in
   `firebase.json`.
2. `cd functions && npm install`
3. `firebase functions:secrets:set BREVO_API_KEY`
4. `firebase deploy --only functions`

The client (`js/api.js`) detects deployed functions? — No: switching backends
requires wiring changes. Treat this folder as a reference implementation.
