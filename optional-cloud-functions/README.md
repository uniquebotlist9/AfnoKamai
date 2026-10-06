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

## Referral callables (reference only — not deployed)

The referral flow has a server-side mirror in `index.js` so the reward logic can
move to a trusted server the day you enable Blaze:

| Callable | Mirrors | Notes |
|---|---|---|
| `finalizeReferral({ code })` | `js/referral.js` → `finalizeReferral()` | Validates the code, blocks self-referral and double attribution, writes `referrals/{referrer}_{uid}`, the `joined` event and the inviter's one-time notification. |
| `processReferralReward({ referredUserId, taskId, assignmentId, title })` | `js/admin-actions.js` → `processReferralReward()` (admin-claim path) | Same deterministic reward IDs, same `approvedTaskCount` guard, same `config/referral` amounts, same hold-period ledger entry. Admin-auth check required. |
| `reconcileReferral({ referralId })` | `js/admin-actions.js` → `reconcileReferral()` | Replays the referred member's approved-task ledger to backfill missing rewards. |
| `getReferralConfig()` (module-private helper) | `js/referral.js` → `fetchReferralConfig()` | Reads `config/referral`, falls back to the published defaults. |

Same rules as the rest of this folder: **nothing here is deployed**, and the
Spark-plan behaviour does not change if you ignore it — `firestore.rules` plus
the admin-signed client remain the enforced backend.

