import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encryption } from './crypto.mjs';

export function createStore(path, encryptionKey) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL,
      credentials TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY, alias TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS addresses (
      id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES identities(id),
      connection_id TEXT NOT NULL REFERENCES connections(id), external_user_id TEXT NOT NULL,
      UNIQUE(connection_id, external_user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id),
      event_id TEXT NOT NULL, room_id TEXT NOT NULL, author_id TEXT NOT NULL,
      text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(connection_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, message_id TEXT REFERENCES messages(id), address_id TEXT REFERENCES addresses(id),
      connection_id TEXT NOT NULL REFERENCES connections(id), target_id TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(message_id, address_id)
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_pending ON deliveries(status,next_attempt_at);
    CREATE TABLE IF NOT EXISTS bridge_rules (
      id TEXT PRIMARY KEY, source_connection_id TEXT NOT NULL REFERENCES connections(id),
      source_room_id TEXT NOT NULL, target_connection_id TEXT NOT NULL REFERENCES connections(id),
      target_room_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_connection_id,source_room_id,target_connection_id,target_room_id)
    );
    CREATE TABLE IF NOT EXISTS demo_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS demo_messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS verified_accounts (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, external_user_id TEXT NOT NULL,
      display_name TEXT NOT NULL, identity_id TEXT REFERENCES identities(id),
      connection_id TEXT REFERENCES connections(id), verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider,external_user_id,connection_id)
    );

  `);
  const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some(v => v.name === column);
  if (!hasColumn('deliveries', 'target_kind')) db.exec("ALTER TABLE deliveries ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'user'");
  if (!hasColumn('deliveries', 'bridge_rule_id')) db.exec('ALTER TABLE deliveries ADD COLUMN bridge_rule_id TEXT');
  if (!hasColumn('addresses', 'verified_at')) db.exec('ALTER TABLE addresses ADD COLUMN verified_at TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_delivery ON deliveries(message_id,bridge_rule_id) WHERE bridge_rule_id IS NOT NULL');
  const enc = encryption(encryptionKey);
  const q = sql => db.prepare(sql);
  const publicConnection = v => v && ({ id: v.id, platform: v.platform, name: v.name, created_at: v.created_at, webhook_path: `/webhooks/${v.platform}/${v.id}` });
  return {
    close: () => db.close(),
    seedDemo(rooms) {
      q('INSERT OR IGNORE INTO demo_settings(id,enabled) VALUES(1,1)').run();
      q('UPDATE demo_settings SET enabled=1 WHERE id=1').run();
      if (!q('SELECT id FROM demo_messages LIMIT 1').get()) {
        for (const room of rooms) q('INSERT INTO demo_messages(id,room_id,author,text) VALUES(?,?,?,?)')
          .run(randomUUID(),room.id,'系統（純本機模擬）', `歡迎來到 ${room.name}。請在下方傳送訊息，或輸入 @line:alice 測試跨平台模擬通知。`);
      }
    },
    demoEnabled: () => Boolean(q('SELECT enabled FROM demo_settings WHERE id=1').get()?.enabled),
    listDemoMessages: room => q('SELECT * FROM demo_messages WHERE room_id=? ORDER BY rowid LIMIT 100').all(room),
    addDemoMessage(room, author, text) {
      const id = randomUUID();
      q('INSERT INTO demo_messages(id,room_id,author,text) VALUES(?,?,?,?)').run(id,room,author,text);
      return q('SELECT * FROM demo_messages WHERE id=?').get(id);
    },
    listConnections: () => q('SELECT id,platform,name,created_at FROM connections ORDER BY created_at DESC').all().map(publicConnection),
    getConnection: id => {
      const r = q('SELECT * FROM connections WHERE id=?').get(id);
      return r && { ...publicConnection(r), credentials: enc.open(r.credentials) };
    },
    addConnection(platform, name, credentials) {
      const id = randomUUID();
      q('INSERT INTO connections(id,platform,name,credentials) VALUES(?,?,?,?)').run(id, platform, name, enc.seal(credentials));
      return publicConnection(q('SELECT id,platform,name,created_at FROM connections WHERE id=?').get(id));
    },
    updateConnectionCredentials(id, credentials) {
      const result = q('UPDATE connections SET credentials=? WHERE id=?').run(enc.seal(credentials), id);
      return result.changes > 0;
    },
    listIdentities: () => q('SELECT * FROM identities ORDER BY alias').all(),
    addIdentity(alias, displayName) {
      const id = randomUUID();
      q('INSERT INTO identities(id,alias,display_name) VALUES(?,?,?)').run(id, alias, displayName);
      return q('SELECT * FROM identities WHERE id=?').get(id);
    },
    verifyAddress(id) { return q("UPDATE addresses SET verified_at=CURRENT_TIMESTAMP WHERE id=?").run(id).changes > 0; },
    listAddresses: () => q(`SELECT a.*, c.platform, c.name AS connection_name, i.alias FROM addresses a
      JOIN connections c ON c.id=a.connection_id JOIN identities i ON i.id=a.identity_id ORDER BY i.alias`).all(),
    addAddress(identityId, connectionId, externalUserId, verified = false) {
      const id = randomUUID();
      q('INSERT INTO addresses(id,identity_id,connection_id,external_user_id,verified_at) VALUES(?,?,?,?,?)').run(id, identityId, connectionId, externalUserId, verified ? new Date().toISOString() : null);
      return q('SELECT * FROM addresses WHERE id=?').get(id);
    },
    findAddresses(alias, platform) {
      return q(`SELECT a.*, c.platform, i.alias, i.display_name FROM addresses a
        JOIN connections c ON c.id=a.connection_id JOIN identities i ON i.id=a.identity_id
        WHERE i.alias=? AND c.platform=?`).all(alias, platform);
    },
    insertMessage(connectionId, eventId, roomId, authorId, content) {
      const id = randomUUID();
      const r = q('INSERT OR IGNORE INTO messages(id,connection_id,event_id,room_id,author_id,text) VALUES(?,?,?,?,?,?)')
        .run(id, connectionId, eventId, roomId, authorId, content);
      return r.changes ? id : null;
    },
    queueDelivery(connectionId, targetId, text, messageId = null, addressId = null, targetKind = 'user', bridgeRuleId = null) {
      const id = randomUUID();
      const r = q('INSERT OR IGNORE INTO deliveries(id,message_id,address_id,connection_id,target_id,text,target_kind,bridge_rule_id) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, messageId, addressId, connectionId, targetId, text, targetKind, bridgeRuleId);
      return r.changes ? id : null;
    },
    listBridgeRules: () => q(`SELECT b.*,sc.platform AS source_platform,tc.platform AS target_platform,
      sc.name AS source_name,tc.name AS target_name FROM bridge_rules b
      JOIN connections sc ON sc.id=b.source_connection_id JOIN connections tc ON tc.id=b.target_connection_id
      ORDER BY b.created_at DESC`).all(),
    matchingBridgeRules(connectionId, roomId) {
      return q('SELECT * FROM bridge_rules WHERE source_connection_id=? AND source_room_id=? AND enabled=1').all(connectionId, roomId);
    },
    addBridgeRule(sourceId, sourceRoom, targetId, targetRoom) {
      const id = randomUUID();
      q('INSERT INTO bridge_rules(id,source_connection_id,source_room_id,target_connection_id,target_room_id) VALUES(?,?,?,?,?)')
        .run(id, sourceId, sourceRoom, targetId, targetRoom);
      return q('SELECT * FROM bridge_rules WHERE id=?').get(id);
    },
    removeBridgeRule(id) { return q('DELETE FROM bridge_rules WHERE id=?').run(id).changes > 0; },
    listVerifiedAccounts: () => q('SELECT * FROM verified_accounts ORDER BY verified_at DESC').all(),
    recordVerifiedAccount(provider, userId, displayName, identityId = null, connectionId = null) {
      // SQLite considers NULL values distinct in UNIQUE constraints. Match a
      // provider's standalone identity without creating duplicates on each login.
      const current = connectionId == null
        ? q('SELECT id FROM verified_accounts WHERE provider=? AND external_user_id=? AND connection_id IS NULL LIMIT 1').get(provider, userId)
        : q('SELECT id FROM verified_accounts WHERE provider=? AND external_user_id=? AND connection_id=? LIMIT 1').get(provider, userId, connectionId);
      const id = current?.id ?? randomUUID();
      if (current) q('UPDATE verified_accounts SET display_name=?,verified_at=CURRENT_TIMESTAMP WHERE id=?').run(displayName,id);
      else q('INSERT INTO verified_accounts(id,provider,external_user_id,display_name,identity_id,connection_id) VALUES(?,?,?,?,?,?)')
        .run(id,provider,userId,displayName,identityId,connectionId);
      return q('SELECT * FROM verified_accounts WHERE id=?').get(id);
    },
    nextDeliveries: (limit = 10) => q("SELECT * FROM deliveries WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT ?").all(Date.now(), limit),
    finishDelivery: id => q("UPDATE deliveries SET status='sent',attempts=attempts+1,last_error=NULL WHERE id=?").run(id),
    failDelivery: (id, attempts, message, delayMs) => q('UPDATE deliveries SET status=?,attempts=?,last_error=?,next_attempt_at=? WHERE id=?')
      .run(attempts >= 5 ? 'failed' : 'pending', attempts, String(message).slice(0, 200), Date.now() + delayMs, id),
    listMessages: () => q(`SELECT m.*, c.platform, c.name AS connection_name FROM messages m JOIN connections c ON c.id=m.connection_id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 100`).all(),
    listDeliveries: () => q(`SELECT d.id,d.connection_id,d.target_id,d.target_kind,d.bridge_rule_id,d.status,d.attempts,d.last_error,d.created_at,c.platform FROM deliveries d
      JOIN connections c ON c.id=d.connection_id ORDER BY d.created_at DESC,d.rowid DESC LIMIT 100`).all(),
  };
}
