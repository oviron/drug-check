import Database from 'better-sqlite3'
import path from 'path'

// Initialize database
const dbPath = path.join(__dirname, 'subscribers.db')
const db = new Database(dbPath)

// Create subscribers table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    chat_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    subscribed_at INTEGER DEFAULT (unixepoch()),
    is_active INTEGER DEFAULT 1
  )
`)

// Create subscription history table for tracking
db.exec(`
  CREATE TABLE IF NOT EXISTS subscription_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    action TEXT NOT NULL, -- 'subscribe' or 'unsubscribe'
    timestamp INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (chat_id) REFERENCES subscribers(chat_id)
  )
`)

// Prepared statements for better performance
const statements = {
  addSubscriber: db.prepare(`
    INSERT OR REPLACE INTO subscribers (chat_id, username, first_name, last_name, is_active)
    VALUES (@chatId, @username, @firstName, @lastName, 1)
  `),
  
  deactivateSubscriber: db.prepare(`
    UPDATE subscribers SET is_active = 0 WHERE chat_id = ?
  `),
  
  getActiveSubscribers: db.prepare(`
    SELECT chat_id, username, first_name, last_name FROM subscribers WHERE is_active = 1
  `),
  
  checkSubscriber: db.prepare(`
    SELECT is_active FROM subscribers WHERE chat_id = ?
  `),
  
  logAction: db.prepare(`
    INSERT INTO subscription_history (chat_id, action) VALUES (?, ?)
  `)
}

export interface Subscriber {
  chatId: number
  username?: string
  firstName?: string
  lastName?: string
}

export function addSubscriber(subscriber: Subscriber): void {
  const transaction = db.transaction(() => {
    statements.addSubscriber.run({
      chatId: subscriber.chatId,
      username: subscriber.username || null,
      firstName: subscriber.firstName || null,
      lastName: subscriber.lastName || null
    })
    statements.logAction.run(subscriber.chatId, 'subscribe')
  })
  
  transaction()
}

export function removeSubscriber(chatId: number): boolean {
  const transaction = db.transaction(() => {
    const result = statements.deactivateSubscriber.run(chatId)
    if (result.changes > 0) {
      statements.logAction.run(chatId, 'unsubscribe')
      return true
    }
    return false
  })
  
  return transaction() as boolean
}

export function getActiveSubscribers(): Subscriber[] {
  const rows = statements.getActiveSubscribers.all() as Array<{
    chat_id: number
    username: string | null
    first_name: string | null
    last_name: string | null
  }>
  
  return rows.map(row => ({
    chatId: row.chat_id,
    username: row.username || undefined,
    firstName: row.first_name || undefined,
    lastName: row.last_name || undefined
  }))
}

export function isSubscribed(chatId: number): boolean {
  const result = statements.checkSubscriber.get(chatId) as { is_active: number } | undefined
  return result?.is_active === 1
}

// Get statistics
export function getStatistics() {
  const stats = db.prepare(`
    SELECT 
      COUNT(CASE WHEN is_active = 1 THEN 1 END) as active_count,
      COUNT(CASE WHEN is_active = 0 THEN 1 END) as inactive_count,
      COUNT(*) as total_count
    FROM subscribers
  `).get() as { active_count: number; inactive_count: number; total_count: number }
  
  return stats
}

// Close database connection on process exit
process.on('SIGINT', () => {
  db.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  db.close()
  process.exit(0)
})
