# AfnoKamai — Your Work. Your Kamai.

A production-oriented, **free-plan (Spark)** task-and-reward platform for Nepal: users complete
administrator-approved digital tasks, rewards pass through a transparent **3-day hold**, and
eligible funds are withdrawn to **eSewa**. Built with HTML/CSS/vanilla JS on the front end and
**Firebase Auth · Firestore · Hosting** on the back end.

> **Free plan by design.** No Cloud Functions, no Blaze billing account, no Storage bucket.
> The security backend is the Firestore rules file plus the admin's custom-claim-authorized
> client performing atomic transactions. An optional Cloud Functions implementation is kept in
> `optional-cloud-functions/` for a future Blaze upgrade.

```
New Visitor → Login → Signup → Email Verification → Personal Info → Security PIN → Dashboard
    → Request Task → Admin Chat → Assignment → Completion + Evidence → Review
    → Reward → 3-Day Hold (timestamp-driven) → Withdrawable → eSewa Withdrawal → History
```

## 1. Free-plan architecture (how security works without Cloud Functions)

| Concern | Mechanism |
|---|---|
| **Who can change money** | Only admins (`admin == true` custom claim — `scripts/set-admin.cjs`). Firestore rules deny all user writes to `wallets`, `transactions`, `penalties`. |
| **Atomicity / idempotency** | Admin operations run as Firestore `runTransaction`s with status guards — double approvals, double payouts and race conditions are impossible. |
| **Task lifecycle** | Enforced by rules: users may only move `assigned/clarification → submitted`; `approved/rejected` writes are admin-only. |
| **Duplicate requests** | Deterministic IDs: the active assignment for (user, task) always has id `uid_taskId` (creates collide), plus a rules `!exists()` check. Withdrawals: one concurrent request via `activeWithdrawals/{uid}`. |
| **Referral rewards** | Written only by the admin-claim client inside `processReferralReward` (called from `reviewTask`'s approve branch). Deterministic reward IDs (`REFERRAL_MILESTONE_{referrer}_{referred}` / `REFERRAL_TASK_{referrer}_{referred}_{taskId}`) sit on **both** `referralRewards` and `transactions`, so a duplicate is impossible at the document level, and an `approvedTaskCount` guard turns repeated calls into no-ops. Users may create codes, links, vanity handles and exactly one attribution — never a rupee. |
| **3-day hold** | `availableAt` server timestamps are written at approval; the **admin client sweeps** matured holds on load (idempotent). Users compute their true withdrawable balance from the same timestamps — browser timers never move money. |
| **PIN** | PBKDF2-SHA256 (120k iterations, random salt) via Web Crypto. The hash lives in `users/{uid}/private/pin` — **write-only for the owner, readable only by admins** (a stolen session cannot brute-force it). Withdrawal requests carry a PIN proof; the admin's review page shows Verified / Mismatch before payout. |
| **Input validation** | Firestore rules validate name/phone regexes, eSewa number format, amount bounds, field whitelists and message size caps server-side. |
| **Ban enforcement** | `notBanned()` in rules blocks requests, submissions, withdrawals and chat for restricted accounts. |
| **Rate limiting** | Firebase Auth throttles login/resend. App-side: client throttles (verification resend, chat) + admin risk flags. Full server-side rate limiting needs the optional Cloud Functions. |
| **Emails** | Firebase's built-in verification & password-reset (free, reliable). Transactional Brevo emails are an optional Blaze upgrade — the key never appears in frontend code in either mode. |

## 2. Feature map

- **Auth chain** — login/signup/verification/profile/PIN with no-bypass routing; protected by `js/guard.js`.
- **Earn** — searchable, filterable (category/difficulty), sortable task marketplace with slots remaining, deadlines, priority and evidence-required markers. Task lifecycle: available → requested → assigned → submitted → under review → approved/rejected → hold → withdrawable.
- **Wallet & ledger** — every rupee is a `transactions` record with ID, type, status, `balanceAfterPaisa` and reference. Hold countdowns, computed withdrawable balance, penalties and adjustments are all auditable.
- **Withdraw** — eSewa form with PIN, confirm summary, concurrency lock, and a **status tracker** (Requested → Under review → Approved → Processing → Completed / Rejected + reason).
- **Statements** — monthly earnings report + CSV export on the Transactions page.
- **Chat** — real-time, typing indicators, read receipts (**admin sees "Seen 5 mins ago" / "Delivered"** on its own messages, on system notices and on each conversation row; the user keeps the compact tick), inline photo/PDF attachments (photos ≤ 500 KB, PDFs ≤ 400 KB — the Firestore 1 MiB document cap rules out video), image lightbox, admin moderation (delete), send throttling, truthful presence. Every administrator message also writes a website notification (`admin_message`, `priority: high`) from the admin's session — users cannot create notifications, so the write has to happen where the message is sent.
- **Notifications** — full center with filters (including an **Admin messages** tab), unread badges, deep links; generated by admin actions. Two priorities: `urgent` (task assigned — modal popup with an **Open chat** button, because the private instructions live in the chat) and `high` (admin messages and clarification requests — live toast with an **Open chat** action). Both clear automatically once the user opens the thread.
- **Admin panel** — overview (aggregation queries, 14-day charts), users (search, filters, financial/task/withdrawal/penalty tabs, **internal notes**, **risk flags**), task library (draft/published/paused/archived, slots, deadlines, evidence flag), review queue, withdrawals with **PIN proof verification**, penalties, announcements, maintenance mode, immutable audit log, platform settings.
- **Referrals** — every account gets a stable `AFK-XXXXXXXX` code, a personal link (`/ref/CODE`) and an optional vanity handle; Copy Link / Copy Code / native Share. The public `/ref` landing page validates a code without exposing who invited whom (generic OG metadata), and attribution happens **once**, only at the end of signup — self-referral, re-attribution and code squatting are blocked by rules. The Referral page shows real stats, the invite card, the reward rules, the member list with detail/earnings/activity, and an honest retry banner for a code captured during signup. Admin gets a full **Referrals** panel: overview, members, rewards ledger, risk flags ("Review recommended", never an accusation), configuration and audit.
- **Performance & trust** — success rate, account standing, achievement badges (First Task, 10/50 Tasks, Trusted Worker).
- **PWA** — manifest, service worker, install prompt in the user menu.
- **Dark mode** — Light / Dark / System with persistence, in both user and admin menus.
- **Help center** — categorized FAQs (Account, Tasks, Earnings & Hold, Withdrawals, Security, Rules) + support chat.
- **Honesty rules** — no fake data anywhere: empty states when there is nothing to show; errors are friendly and never leak Firebase internals.

## 3. Project layout

```
afnokamai/
├── index.html                  # Router: sends visitors to login or their app step
├── login/signup/verify-email/profile-setup.html
├── dashboard/earn/withdraw/transactions/notifications/profile/rules/support/chat.html
├── ref.html  referral.html     # public invite landing page + referral dashboard
├── maintenance.html, 404.html, manifest.json, sw.js
├── admin/                      # 13 admin pages (incl. referrals)
├── css/  (global + dark theme, auth, app, chat, admin)
├── js/
│   ├── firebase-config.js      # your live project config
│   ├── firebase.js  guard.js  shell.js  admin-shell.js
│   ├── api.js                  # user operations (direct validated writes)
│   ├── admin-actions.js        # admin operations (atomic transactions + sweep)
│   ├── pin.js                  # PBKDF2 PIN hashing / proofs
│   ├── referral.js             # codes, links, vanity handles, attribution
│   ├── theme.js                # light/dark/system
│   └── pages/…                 # one module per page (user + admin/*)
├── firestore.rules             # THE backend: validation, state machines, dedupe, referral attribution
├── firestore.indexes.json
├── scripts/                    # set-admin.cjs (free-plan admin bootstrap), check-imports.cjs
└── optional-cloud-functions/   # Blaze upgrade path — NOT deployed
```

## 4. Setup (free plan only)

1. **Firebase console** (project `afnokamai`):
   - Authentication → enable Email/Password (already done)
   - Firestore → create database
   - **Do NOT** upgrade to Blaze — everything works on Spark.
2. **Deploy** (hosting + rules + indexes):
   ```bash
   npm i -g firebase-tools
   firebase login
   firebase deploy
   ```
3. **Bootstrap an administrator** — sign up once through the app, then:
   ```bash
   cd scripts && npm install
   # Firebase console → Project settings → Service accounts →
   # Generate new private key → save as scripts/serviceAccount.json
   node set-admin.cjs you@example.com
   ```
   Log out and back in, then open `/admin/`.
4. **First-run config** (admin → Settings): hold days (default 3), minimum withdrawal (default रु 500), support email, task rules. Then create tasks in the Task library and **publish** them.

### 4b. Email notifications (EmailJS — optional, free)

Account verification and password reset always use Firebase's own emails.
App notification emails (welcome, task request, withdrawal events, security
alerts, penalties, admin alerts) use **EmailJS**, which sends directly from
the browser — no server, no paid plan.

1. Create a free account at [emailjs.com](https://www.emailjs.com) (200 emails/month free).
2. **Email Services** → add your mailbox → copy the **Service ID**.
3. **Email Templates** → create one template per entry in
   `js/email-config.js` and paste each **Template ID**. Required variables:

   | Template key | Variables |
   |---|---|
   | `welcome` | `to_name`, `to_email`, `app_name` |
   | `task_request_received` | `to_name`, `to_email`, `task_title`, `reward` |
   | `withdrawal_submitted` | `to_name`, `to_email`, `amount`, `esewa_name`, `esewa_number` |
   | `withdrawal_completed` | `to_name`, `to_email`, `amount`, `esewa_name` |
   | `withdrawal_rejected` | `to_name`, `to_email`, `amount`, `reason` |
   | `penalty_applied` | `to_name`, `to_email`, `amount`, `reason` |
   | `security_alert` | `to_name`, `to_email`, `event`, `details`, `time` |
   | `admin_alert` | `subject`, `details`, `time` — **set To Email to your own address inside the template** |

4. **Account → General** → copy the **Public Key**.
5. Paste all values into `js/email-config.js`. Done — emails send
   automatically from the flows. Never configured? Everything still works;
   emails simply skip (they are decoration, never a security step).
6. In the EmailJS dashboard, restrict the service to your domain
   (`afnokamai.web.app`) so your free quota can't be borrowed elsewhere.

⚠️ Only the **public key** goes in the config file — never the private key.

## 5. Admin operations reference (js/admin-actions.js)

| Operation | Guarantees |
|---|---|
| `reviewTask` (assign/cancel/approve/reject/clarify) | Status-guarded transaction; approve moves reward to hold with `availableAt`; final decisions move the assignment to history, freeing the deterministic dedupe ID; slot counters update the task (auto-"full"). |
| `sweepHolds` | Releases matured holds (availableAt ≤ now) into available balance; per-transaction guard makes it idempotent; runs on admin login and before payout completion. |
| `reviewWithdrawal` (under_review/processing/completed/rejected) | Completion sweeps first, then a transaction verifies `availablePaisa ≥ amount` and writes the debit ledger entry with `balanceAfterPaisa`; rejection requires a reason and never touched the balance. |
| `applyPenalty` | Deducts from available balance only (never negative); if partially available, applies what exists and says so; permanent `penalties` record + notification. |
| `adjustBalance` | Signed, clamped-at-zero adjustments with ledger entry + audit. |
| `banUser` | Rules-enforced restriction (requests/submissions/withdrawals/chat all blocked); audit + notification. Auth-level disable is a Blaze/SDK feature — see limitations. |

## 6. Referral & invite system

Rewards are **रु 15** after a referred member's first **2 approved** tasks, then **रु 5** for
every approved task after that. Nothing is ever earned from a submitted, pending or rejected task.

### 6a. Attribution (who gets credited)

```
/ref/CODE  (or ?ref=CODE)  →  signup form (optional code field)  →  verify email
    →  personal info  →  PIN  →  finalizeReferral()  →  permanent relationship
```

- Every new account ships with a unique, stable code in the **same atomic batch** as its `users`
  document (`referralCodes/{code}` is created alongside — rules re-verify the mapping with
  `getAfter()`, so nobody can claim a code belonging to someone else). Accounts that existed
  before the feature was turned on get theirs on the first visit to the Referral page
  ("Generate my referral code") — same rules, same one-time claim.
- The relationship is written **once**, at the very end of registration, as
  `referrals/{referrerId}_{referredUid}`. The doc ID pins ownership: it can never be
  re-assigned, and an existing account cannot be re-attributed by opening a link later
  (the `/ref` page says so instead of pretending).
- Self-referral is rejected client-side *and* in rules. A captured code that fails is not
  silently dropped: it stays in `localStorage` and the Referral page offers a retry banner
  for **48 hours**, after which ownership stays fixed.
- Codes are validated by a regex in both `firestore.rules` and `js/referral.js`
  (`^AFK-[A-HJ-NP-Z2-9]{8}$` — no 0/O/1/I, so a code survives being read aloud).
  Vanity handles are lowercase 3–30 chars with a **reserved-word blocklist mirrored in both
  files** (`admin`, `support`, `login`, `referral`, …).

### 6b. Rewards (where the money comes from)

`reviewTask`'s approve branch calls `processReferralReward()` — the **admin-claim client**,
exactly like every other financial write in this app:

| Step | Why it is safe |
|---|---|
| Reads `users/{referred}.referredBy` → `referrals/{referrer}_{referred}` | A member with no referral is a no-op. |
| `newCount = approvedTaskCount + 1` (outside the transaction) | Used only to pick the reward kind; the transaction re-reads and requires `newCount === current + 1`, so a stale value becomes a no-op instead of a wrong payout. |
| Reward ID = `REFERRAL_MILESTONE_{referrer}_{referred}` (once) or `REFERRAL_TASK_{referrer}_{referred}_{taskId}` | The **same ID** is used for the `referralRewards` document *and* the `transactions` ledger entry — a duplicate physically cannot exist. |
| Writes `transactions/{rewardId}` with `status: 'hold'` + `availableAt` | Referral money enters the **existing** hold pipeline; `sweepHolds` releases it with no second wallet, no second balance and no special case. |
| Increments `wallets/{referrer}.holdPaisa/earnedPaisa`, `referrals.totalEarnedPaisa`, `users.referralStats`, `stats/referralTotals` | All in one `runTransaction` — either the whole reward lands or none of it does. |
| Amounts come from `config/referral` | The browser never computes or supplies a reward value. |

`reconcileReferral` / `reconcileAllReferrals` backfill anything missed (a failure between
approval and reward processing, a network drop during notification) by replaying the
referred member's `task_reward` ledger entries. If referral rewards are **suspended** for
review, the task count still advances but no money moves — resuming plus a reconcile pays
exactly the missing rewards.

### 6c. Data model

| Path | Written by | Purpose |
|---|---|---|
| `users/{uid}` → `referralCode`, `referralHandle`, `referredBy`, `referredByCode`, `referralJoinedAt`, `referralStats` | user (identity) + admin (stats) | Identity and the permanent attribution pointer. |
| `referralCodes/{code}` · `referralHandles/{handle}` | owner only, immutable | Public lookup docs — the anonymous `/ref` page validates a code before signup. |
| `referrals/{referrer}_{referred}` | create: referred user (once) · update: admin only | Relationship + counters (`approvedTaskCount`, `totalEarnedPaisa`, `milestoneReached`, `rewardsSuspended`, `underReview`, hashed `deviceSig`). |
| `referrals/{id}/events/*` | `joined` by the referred user · the rest by admin | Per-referral activity timeline; the collection-group query is served by its composite index. |
| `referralRewards/{rewardId}` | admin only | One record per paid reward; `rewardId === transactionId`. |
| `referralRiskFlags/{flagId}` | admin only | Advisory signals — never visible to users. |
| `config/referral` | admin only | `enabled`, `milestoneTasks`, `milestoneRewardPaisa`, `recurringRewardPaisa`, risk thresholds. Changes affect **future** rewards only; `enabled: false` pauses the program without touching anything already credited. |
| `stats/referralTotals` | admin only | Platform-wide aggregate. |

### 6d. Surfaces

- **`/ref/CODE`** (`ref.html`) — public landing, generic preview metadata (no code or name
  ever appears in an OG tag), validates the code, stores it for signup, and tells a signed-in
  visitor plainly that links only apply to new accounts.
- **`referral.html`** — invite card (Copy Link / Copy Code with honest clipboard failure,
  `navigator.share` with a copy fallback, vanity handle with reserved-name blocking), reward
  rules read from config, real stats via aggregation/count queries, the member list with a
  detail modal (earnings breakdown + activity), and privacy-safe content only.
- **`admin/referrals.html`** — Overview / Members / Rewards / Risk flags / Configuration /
  Audit: search, status filters, CSV export, reconcile, pause–resume, mark under review,
  suspend–resume rewards, resolve flags (with a note written to `adminLogs`).

### 6e. Risk, privacy and tone

Signals are computed from a **hashed device signature** (user agent + screen + timezone — no
raw IP is stored or shown) and coarse counts: too many accounts per device, too many signups
per code in the window, referrals with zero activity after N days. Every flag reads
**"Review recommended"** and explains that shared Wi-Fi, schools, offices and families are
normal — a human always decides, and a flag never auto-penalises anyone.

## 7. Honest limitations (free plan)

- **Server-side rate limiting** of task requests/submissions/chat is advisory (client throttle + admin review + risk flags), not enforced. Cloud Functions would make it authoritative.
- **PIN change** requires account-password re-authentication (not the old PIN) because the hash is deliberately unreadable — the withdrawal PIN proof check at admin review is the financial gate.
- **Permanent bans** block all app actions via rules but cannot disable Firebase Auth login itself without the Admin SDK.
- **Attachments** are inline in Firestore (photos ≤ 500 KB, PDFs ≤ 400 KB, no video) — a 1 MiB document-limit trade-off. They inherit message permissions (more private than a bucket).
- **Push notifications (FCM)** and **PDF statements** need a server or a print library — deferred (in-app notifications and CSV cover the need today). Email notifications are covered by EmailJS (§4b) — notification-only, rate-limited, and never a security step.
- **Nepali translation** — planned as a dedicated i18n pass; not yet implemented.
- **Referrals** — attribution is deliberately one-shot and only for accounts that finish signup with a captured code (existing accounts can never be linked later, and the retry banner expires after 48 h). Rewards are written by the admin client during task approval, so an approval that happens while the admin panel is closed pays on the next **Reconcile all** rather than instantly.
- Legal texts in the signup modals are drafts — have them reviewed before launch.

## 8. Testing checklist

- Visitor → login → signup → verify (resend + 60 s cooldown) → profile → PIN → dashboard.
- Request task (try twice — second is blocked) → admin assigns in chat → user submits with evidence → admin approves → hold + countdown appears → admin sweeps/matures → withdrawable.
- Withdraw below minimum / above withdrawable / with a concurrent pending request / wrong PIN → rejected client-side or flagged at review.
- Reject withdrawal → no money ever moved; reason shown in tracker.
- Penalty/ban → user notified and blocked; audit entries created.
- Try writing `wallets/{uid}` or `transactions/x` from the console as a normal user → permission denied.
- Referral: open `/ref/CODE` → sign up → verify → profile → PIN → both sides see the relationship and the inviter gets exactly one "joined" notification; signing up with your own code is refused; opening a link while signed in changes nothing.
- Approve a referred member's 1st task → nothing paid; 2nd → रु 15 on hold; 3rd → रु 5. Approving twice, refreshing mid-approval, or running **Reconcile all** twice never doubles a reward.
- Try writing `referrals/x`, `referralRewards/y` or `config/referral` from the console as a normal user → permission denied.
- Light/dark theme + install prompt + offline banner.

## 9. Local development

```bash
firebase emulators:start   # auth 9099 · firestore 8080 · hosting 5000
```

Un-configured deployments show an explicit "Firebase configuration needed" screen — no fake data anywhere in the product.
