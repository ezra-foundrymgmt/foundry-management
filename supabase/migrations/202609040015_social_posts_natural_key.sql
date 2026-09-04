begin;

-- social_posts had no usable idempotency arbiter, so a re-import duplicated
-- every row it touched.
--
-- The table's only unique constraint is unique(social_account_id,
-- external_post_id) and BOTH columns are nullable. social_account_id is
-- populated only by the activation workflow (apps/web/src/lib/
-- activation-records.ts requestSocialIntegrations), never by an import, so an
-- imported row always carries NULL there -- and a unique index treats NULLs as
-- distinct. Confirmed against staging rather than inferred: two byte-identical
-- inserts both returned 201 and left two rows.
--
-- The duplicate is not cosmetic. Both readers -- daily-report.ts and
-- baselines.ts -- sum reach across every row in the window with no dedupe, so
-- a double-submitted import doubles reach. That can lift a creator over the
-- `current.reach >= 1000` floor that gates both reach rules in
-- packages/domain/src/revenue-diagnostic.ts, manufacturing a finding out of a
-- double-click, and baselines.ts freezes the doubled figure permanently.
--
-- Key choice: (creator_id, platform, external_post_id).
--   creator_id implies organization_id through the creators FK, which is why
--   creator_revenue_daily's key is (creator_id, date, platform, source) and
--   carries no org column. Mirror that.
--
--   platform is in the key because external_post_id is only unique within a
--   platform -- two platforms can both mint "12345".
--
--   source is deliberately NOT in the key, and this is the one place
--   social_posts must diverge from creator_revenue_daily. A revenue row is a
--   per-day aggregate claim, so two sources reporting the same day are two
--   claims. A post is a single object in the world; two sources describing it
--   are two descriptions of one thing. With source in the key both rows would
--   survive and both would be summed.
--
-- Non-partial, following 202609030014 and 202609020012: PostgreSQL infers a
-- partial unique index as an ON CONFLICT arbiter only when the statement's own
-- WHERE clause matches the index predicate, and PostgREST's upsert never
-- supplies one, so a partial index raises 42P10 on the first insert. NULLs
-- being distinct means a row with no external_post_id still does not collide
-- with another that also has none -- which is why the column stays nullable
-- even though the import path requires it.
--
-- The existing unique(social_account_id, external_post_id) constraint is
-- retained rather than dropped. It is not this upsert's arbiter, and because
-- an import never supplies social_account_id neither half of the upsert can
-- violate it.
create unique index if not exists social_posts_creator_platform_post_uidx
  on public.social_posts (creator_id, platform, external_post_id);

commit;
