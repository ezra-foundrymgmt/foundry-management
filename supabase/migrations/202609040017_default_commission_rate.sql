begin;

-- Records Foundry's standard commission rate as organisation configuration.
--
-- `readCommissionRate` deliberately returns NULL for an unset rate rather than
-- a default, because this number is printed into the welcome package a creator
-- reads and forms a commercial expectation from. An earlier version defaulted
-- to 0.30 whenever the key was absent — and since nothing ever wrote the key,
-- every organisation was unconfigured, so every welcome package stated
-- "Foundry takes 30% of your platform receipts" as a fact nobody had entered.
-- It also bypassed the guard built for exactly this case, which says
-- "Commission rate not recorded. Do not send this without it."
--
-- Removing that default means the value has to exist somewhere real. There is
-- no settings UI for it yet, so it is bootstrapped here — the same approach
-- 202609020005 already takes for organisation configuration.
--
-- Idempotent and non-destructive: an organisation that already has a rate keeps
-- it, so re-running this never overwrites a negotiated change. Per-creator
-- overrides live on creator_pnl_periods.commission_rate and are unaffected.
update public.organizations
set settings_json = jsonb_set(
      coalesce(settings_json, '{}'::jsonb),
      '{defaultCommissionRate}',
      '0.30'::jsonb,
      true
    ),
    updated_at = now()
where settings_json->'defaultCommissionRate' is null;

commit;
