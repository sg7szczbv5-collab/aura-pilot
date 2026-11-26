-- ============================================================================
-- AURA · 016 · Admin console: reject a captain document with a direct update
-- ----------------------------------------------------------------------------
-- The admin Applications screen rejects a document with
--   update driver_documents set status = 'rejected', rejection_reason, reviewed_at,
--                               updated_at, reviewed_by where id = … and status = 'uploaded'
-- instead of calling admin_review_document(). Until now `authenticated` had no
-- UPDATE privilege on the table, so that statement failed with "permission denied".
--
-- This grants only those five columns and adds a policy that allows exactly one
-- transition, uploaded → rejected, for staff with drivers.edit (MFA enforced by
-- admin_can), with a non-empty reason and reviewed_by = the caller.
-- Approvals still go through admin_review_document() (expiry check etc.).
-- Captains get no new rights: admin_can() is false for them.
-- ============================================================================

grant update (status, rejection_reason, reviewed_at, reviewed_by, updated_at)
  on public.driver_documents to authenticated;

create policy driver_documents_admin_reject on public.driver_documents
  for update to authenticated
  using (status = 'uploaded' and private.admin_can('drivers.edit'))
  with check (
    status = 'rejected'
    and length(btrim(coalesce(rejection_reason, ''))) > 0
    and reviewed_by = (select auth.uid())
    and private.admin_can('drivers.edit')
  );
