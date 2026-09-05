# Creator intake — Google Form bridge

How a creator's answers to the **Foundry MGMT Model Information Sheet** reach CreatorOS.

## The shape of it

```
CreatorOS                      Google Form                    CreatorOS
─────────                      ───────────                    ─────────
issue link  ──► CR-000016-7KQ2 ──► she fills it in ──► Apps Script ──► POST /api/intake/google-form
                                                       (HMAC signed)     │
                                                                         ▼
                                                          creator_intake_submissions
                                                            status = PENDING_REVIEW
                                                                         │
                                                          operator reviews and applies
                                                                         ▼
                                            brand profile · boundaries · truth items ·
                                            content pillars · social handles ·
                                            adult-confirmation evidence
```

Two things are worth understanding before changing any of this.

**The reference code is a correlator, not a credential.** Google Forms has no
hidden and no read-only field. The prefilled value arrives as a visible
`entry.583367904=` URL parameter that the respondent can read, edit, clear or
forward. It answers *which creator is this*, and nothing more.

**Authorisation lives elsewhere.** The HMAC signature proves a POST came from
Foundry's own Apps Script. Everything past that point is inert until an
authenticated operator reviews the submission and applies it. A forged or
mistyped code can at worst attach reviewable data to a real creator, which an
operator then rejects. It can never change a creator record on its own.

## One-time setup

### 1. Generate the shared secret

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Set the same value in both places:

- **Vercel** → project `creatoros` → Settings → Environment Variables →
  `CREATOR_INTAKE_SIGNING_SECRET` (Preview *and* Production).
- **Apps Script** → Project Settings → Script Properties → `FOUNDRY_INTAKE_SECRET`.

If the variable is missing on the server the endpoint returns 503 and stores
nothing. It never falls back to accepting unsigned requests.

### 2. Paste the script

Open the form → ⋮ → **Extensions → Apps Script**, replace the contents of
`Code.gs` with `docs/creator-intake-apps-script.js` from this repo, and save.

### 3. Install the trigger

In the Apps Script editor: **Triggers** (clock icon) → *Add Trigger* →

| Field | Value |
|---|---|
| Function | `onFormSubmit` |
| Event source | **From form** |
| Event type | **On form submit** |

**From form**, not *From spreadsheet*. The form-bound event exposes stable
numeric item ids; the spreadsheet-bound one is keyed by question *title*, so
re-wording a question would silently break every mapping.

Authorise when prompted — the script needs `script.external_request` to POST out.

### 4. Check it

Submit the form once yourself. Then:

- Apps Script → **Executions** should show `onFormSubmit` completed.
- CreatorOS should hold a row in `creator_intake_submissions`. With no reference
  code it lands as `UNMATCHED`, which is the correct outcome for a test.

## Field mapping

Item ids are pinned in `packages/domain/src/creator-intake.ts`. They survive
re-wording a question; they do **not** survive making a copy of the form. If the
form is ever duplicated, re-read the ids and update `INTAKE_ITEM_IDS`.

| Question | Lands in |
|---|---|
| Reference Code | matches `creator_intake_links.reference_code` |
| Stage Name / OF Username | recorded for review — never overwrites `creators.stage_name` |
| Age | `creator_compliance_checks` evidence (`ADULT_CONFIRMATION`) |
| Languages Spoken | `creator_brand_profiles.languages` |
| What content are you comfortable creating | `creator_truth_items`, `item_type = 'approved'`, one row per ticked box |
| Hard NOs / Boundaries | `creator_boundaries` (`CONTENT`, `HARD`) + `creator_truth_items` `'prohibited'` |
| Content Ideas or Themes | `content_pillars`, when written as a list |
| Open to collaborating | a `COLLABORATION` boundary only when the answer is No |
| Days available per week | `creator_brand_profiles.content_days_per_week` |
| Preferred shooting days/times | `creator_brand_profiles.preferred_shooting_times` |
| Any schedule restrictions | `creator_boundaries` (`SCHEDULING`, `SOFT`) |
| Describe your online persona | `creator_brand_profiles.positioning_statement` |
| What your audience likes | `creator_brand_profiles.primary_audience` |
| Fun facts or hobbies | `creator_brand_profiles.known_for` |
| Main goals with OnlyFans | `creator_brand_profiles.creator_goals` |
| Instagram / TikTok / Twitter | `social_accounts.handle` |
| I confirm I am 18 or older | `creator_compliance_checks.status = 'CREATOR_ATTESTED'` |

### Judgements the mapper makes, and why

- **An unticked content box is silence, not a prohibition.** Recording every
  unticked type as prohibited would put words in a creator's mouth that then
  constrain everything CreatorOS suggests. Only the Hard NOs answer prohibits.
- **Free text splits only where she created structure** — newlines, semicolons,
  bullets. Cutting prose at commas would turn *"I'm fine with most things, but
  nothing involving my family"* into a HARD boundary reading *"I'm fine with
  most things"*.
- **Prose themes create no pillars.** A pillar named after half a sentence is
  unusable, and `unique(creator_id, name)` makes it permanent. The submission
  raises a note for a person instead.
- **An unreadable age is unknown** — not underage, and not adult. It blocks
  nothing and tells a human.
- **Ticking the 18+ box does not set the activation gate.** It writes evidence.
  `creators.adult_confirmation_status` stays a Foundry judgement, recorded
  against the person who makes it.

## When something goes wrong

| Symptom | Cause |
|---|---|
| 401 `INVALID_SIGNATURE` | Secret mismatch, or clock skew over 5 minutes |
| 503 `INTAKE_NOT_CONFIGURED` | `CREATOR_INTAKE_SIGNING_SECRET` missing on the server |
| 404 `UNKNOWN_FORM` | `organizations.settings_json.intakeFormId` does not match the submitting form |
| Submission stored as `UNMATCHED` | She cleared or edited the Reference Code — match it by hand |
| Answers in `unrecognized_json` | A question was added to the form and not to `INTAKE_ITEM_IDS` |

Apps Script has no documented retry. A failed POST is logged in **Executions**
and the form owner gets a failure email; the response itself is never lost,
because it is still in the form's own responses. Re-delivering it is a matter of
opening the response and re-saving it, which re-fires the trigger.
