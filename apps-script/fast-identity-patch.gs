/**
 * Chain Watcher fast identity confirmation patch.
 *
 * Add `confirmMemberIdentityFast` to getApiHandlers_(), next to the existing
 * confirmMemberIdentity entry:
 *
 *   confirmMemberIdentity,
 *   confirmMemberIdentityFast,
 *
 * Then paste this function into Code.gs near confirmMemberIdentity().
 * It returns only the new member session, so the frontend can stop waiting
 * for the heavier getAppData() call during the identity confirmation click.
 */
function confirmMemberIdentityFast(confirmationToken) {
  ensureInstalled_();
  const claims = parseSignedToken_(confirmationToken, 'identity-confirmation');
  const member = getMembers_().find((item) => (
    isAuthorizedScheduleMember_(item) && String(item.id) === String(claims.memberId)
  ));
  if (!member) throw new Error('This faction or manual membership is no longer active. Verify your API key again.');

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + APP.MEMBER_SESSION_DAYS * 86400;
  const sessionToken = createSignedToken_({
    purpose: 'member-session',
    memberId: String(member.id),
    issuedAt: now,
    expiresAt,
  });
  appendAudit_(member.id, member.name, 'Identity confirmed', `${APP.MEMBER_SESSION_DAYS}-day member session issued`);
  return {
    sessionToken,
    expiresAt,
    member: { id: String(member.id), name: member.name },
  };
}
