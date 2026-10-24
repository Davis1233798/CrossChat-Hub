const validConversationId = value => typeof value === 'string' && /^[CGD][A-Z0-9]+$/.test(value);

/** Main-only adapter: exact selected Slack conversation and verified account only. */
export function createSlackPersonalAdapter({ accountService, userApi, destinations, selectionId, selectedAccount, sourceValid = () => true } = {}) {
  if (!accountService || !userApi?.isConfigured || !destinations || typeof selectionId !== 'string') return null;
  const selection = destinations.resolveSelection(selectionId);
  const account = accountService.getStatus();
  if (selection.status !== 'identified' || account.state !== 'connected' || !account.account || !selectedAccount ||
      account.account.accountId !== selectedAccount.accountId || selection.teamId !== selectedAccount.teamId ||
      !validConversationId(selection.conversationId)) return null;
  const target = Object.freeze({ platform: 'slack', accountId: account.account.accountId, chatId: selection.conversationId });
  const generation = accountService.getGeneration();
  const current = () => {
    const latest = destinations.resolveSelection(selectionId);
    const status = accountService.getStatus();
    return sourceValid() && latest.status === 'identified' && latest.teamId === selection.teamId && latest.conversationId === selection.conversationId &&
      latest.revision === selection.revision && status.state === 'connected' && status.account?.accountId === target.accountId &&
      accountService.getGeneration() === generation;
  };
  return Object.freeze({
    platform: 'slack', accountKind: 'personal', capabilities: Object.freeze({ sendText: true, nativeMention: false, attachments: false }),
    validatePlan: plan => current() && plan.target.accountId === target.accountId && plan.target.chatId === target.chatId,
    preflight: async plan => {
      if (!current() || plan.target.accountId !== target.accountId || plan.target.chatId !== target.chatId || plan.mention || plan.attachments.length) return { status: 'rejected' };
      const result = await accountService.withVerifiedAccount({ accountId: target.accountId, teamId: selection.teamId, userId: account.account.userId }, async () => ({ status: 'ready' }));
      return result.status === 'ready' && current() ? result : { status: 'rejected', reason: 'slack-account-changed' };
    },
    resolveChat: async id => current() && id === target.chatId ? [target] : [],
    execute: async plan => {
      if (!current() || plan.target.accountId !== target.accountId || plan.target.chatId !== target.chatId || plan.mention || plan.attachments.length) return { status: 'rejected' };
      const response = await accountService.withVerifiedAccount({ accountId: target.accountId, teamId: selection.teamId, userId: account.account.userId }, async ({ accessToken, account: verifiedAccount }) => {
        if (!current()) return { status: 'rejected' };
        return userApi.postPlainText({ accessToken, account: verifiedAccount, channelId: target.chatId, text: plan.text,
          validateBeforeDispatch: () => current() && accountService.getGeneration() === generation });
      });
      if (response.status === 'submitted') return response.receipt;
      if (response.status === 'unknown') return response;
      return { status: 'rejected', reason: response.reason };
    },
  });
}
