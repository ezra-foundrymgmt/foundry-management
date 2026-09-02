insert into public.organizations(id,name,slug,settings_json) values ('00000000-0000-4000-8000-000000000001','Foundry Management','foundry','{"demo_mode":true,"content_buffer":{"target":14,"warning":10,"critical":7}}');

insert into public.prospects(id,organization_id,prospect_number,preferred_name,stage_name,niche,follower_count_estimate,fit_score,fit_tier,pipeline_stage,source)
values ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','PR-000001','Jessica','Jessica Hart','Fitness & lifestyle',184000,87,'PRIORITY','SIGNED','DEMO_SEED');

insert into public.creators(id,organization_id,creator_number,preferred_name,stage_name,email,country,timezone,start_date,status,contract_status,jurisdiction_review_status,adult_confirmation_status,current_health_status,current_health_score,current_content_buffer_days,primary_platform)
values
('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','CR-000001','Madison','Madison Carter','madison@fictional.demo','US','America/Los_Angeles','2026-09-01','ONBOARDING','SIGNED','PASSED','PASSED','WATCH',71,8,'Instagram'),
('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','CR-000002','Ava','Ava Monroe','ava@fictional.demo','US','America/New_York','2026-06-01','ACTIVE','SIGNED','PASSED','PASSED','GREEN',89,19,'TikTok'),
('20000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','CR-000003','Sarah','Sarah Vale','sarah@fictional.demo','US','America/Chicago','2026-05-12','WATCH','SIGNED','PASSED','PASSED','AT_RISK',58,5,'Instagram');

insert into public.creator_revenue_daily(organization_id,creator_id,date,platform,creator_platform_receipts,new_subscribers,first_buyers,paying_fans,source,data_confidence)
select '00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',d::date,'CREATOR_REVENUE',1100+(extract(day from d)::int*13),55+(extract(day from d)::int%8),20,200,'DEMO_SEED','MEASURED'
from generate_series('2026-08-06'::date,'2026-09-01'::date,'1 day') d;
insert into public.creator_revenue_daily(organization_id,creator_id,date,platform,creator_platform_receipts,new_subscribers,first_buyers,paying_fans,source,data_confidence)
values ('00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','2026-09-02','CREATOR_REVENUE',1482,63,18,228,'DEMO_SEED','MEASURED');

insert into public.workflow_definitions(id,organization_id,name,version,description,steps_json)
values
('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','CREATOR_ACTIVATION_V1',1,'Deterministic 26-step creator activation','[]'),
('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','CREATOR_OFFBOARDING_V1',1,'Manual-first access revocation and archive sequence','["VALIDATE_OFFBOARDING_APPROVAL","REVOKE_FOUNDRY_ACCESS","DISCONNECT_INTEGRATIONS","PREPARE_PERMITTED_DATA_EXPORT","ARCHIVE_OPEN_TASKS","ARCHIVE_NOTION_PROJECTIONS","ARCHIVE_SLACK_CHANNELS","REQUEST_FINAL_FINANCIAL_RECONCILIATION","MARK_CREATOR_FORMER"]');

insert into public.tool_definitions(organization_id,name,version,description,risk_level,required_permission,requires_human_approval) values
('00000000-0000-4000-8000-000000000001','search_creator',1,'Search tenant-scoped creator records',0,'creator.read',false),
('00000000-0000-4000-8000-000000000001','start_creator_onboarding',1,'Start deterministic creator activation',2,'workflow.start',true),
('00000000-0000-4000-8000-000000000001','create_internal_task',1,'Create a low-risk internal task',1,'task.create',false);

select setval('prospect_number_seq',1,true);
select setval('creator_number_seq',3,true);
