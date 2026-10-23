/** Offline sandbox. No fake OAuth tokens or network calls; every message is marked simulation. */
export function createDemo({ store, enabled = false }) {
  const seed = [
    { id: 'demo-telegram', platform: 'telegram', name: 'Telegram · 示範群組' },
    { id: 'demo-slack', platform: 'slack', name: 'Slack · 示範頻道' },
    { id: 'demo-line', platform: 'line', name: 'LINE · 模擬通知' },
  ];
  const requireEnabled = () => { if (!enabled) throw Object.assign(new Error('Demo is disabled'), { status: 404 }); };
  return {
    get enabled() { return enabled; },
    login() {
      requireEnabled();
      store.seedDemo(seed);
      return { name: '本機示範帳號', mode: 'offline', rooms: seed };
    },
    rooms() { requireEnabled(); return store.demoEnabled() ? seed : []; },
    messages(room) {
      requireEnabled();
      if (!seed.some(r => r.id === room) || !store.demoEnabled()) throw Object.assign(new Error('Demo room not found'), { status: 404 });
      return store.listDemoMessages(room);
    },
    send(room, content) {
      requireEnabled();
      if (!seed.some(r => r.id === room) || !store.demoEnabled()) throw Object.assign(new Error('Demo room not found'), { status: 404 });
      if (typeof content !== 'string' || !content.trim() || content.length > 3500) throw Object.assign(new Error('Invalid message'), { status: 400 });
      const message = store.addDemoMessage(room, '我（模擬）', content);
      // The only cross-platform forwarding in demo is LOCAL, labelled explicitly.
      for (const [, p] of content.matchAll(/@(telegram|slack|line):alice\b/gi)) {
        const destination = `demo-${p.toLowerCase()}`;
        if (destination !== room) store.addDemoMessage(destination, 'CrossChat 示範轉送', `[純本機模擬 · 非真實通知]\n${content}`);
      }
      return message;
    },
  };
}
