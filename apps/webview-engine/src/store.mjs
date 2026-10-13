import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EngineError, fingerprint } from './domain.mjs';

export class TaskStore {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, request TEXT NOT NULL, request_hash TEXT NOT NULL,
        idempotency_key TEXT UNIQUE, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        progress TEXT NOT NULL DEFAULT '{}', artifact TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS coordinator (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL);
    `);
  }
  acquire() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db
        .prepare('SELECT pid FROM coordinator WHERE id=1')
        .get();
      if (old) {
        let alive = true;
        try {
          process.kill(old.pid, 0);
        } catch (e) {
          if (e.code === 'ESRCH') alive = false;
        }
        if (alive)
          throw new EngineError(
            'WORKER_ALREADY_RUNNING',
            '该数据目录已有运行中的协调进程',
          );
      }
      this.db
        .prepare('INSERT OR REPLACE INTO coordinator(id,pid) VALUES(1,?)')
        .run(process.pid);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  release() {
    this.db.prepare('DELETE FROM coordinator WHERE pid=?').run(process.pid);
  }
  recover() {
    this.db
      .prepare(
        "UPDATE tasks SET status='failed', updated_at=?, error=? WHERE status IN ('running','packaging','uploading')",
      )
      .run(
        new Date().toISOString(),
        JSON.stringify({
          code: 'WORKER_INTERRUPTED',
          message: '协调进程中断；避免重复业务操作，不自动重放探索',
        }),
      );
  }
  create(request, idempotencyKey = null) {
    const hash = fingerprint(request);
    if (idempotencyKey) {
      const old = this.db
        .prepare('SELECT * FROM tasks WHERE idempotency_key=?')
        .get(idempotencyKey);
      if (old) {
        if (old.request_hash !== hash)
          throw new EngineError(
            'IDEMPOTENCY_CONFLICT',
            '同一 Idempotency-Key 对应不同请求',
            409,
          );
        return this.decode(old);
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO tasks(id,request,request_hash,idempotency_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        id,
        JSON.stringify(request),
        hash,
        idempotencyKey,
        'queued',
        now,
        now,
      );
    return this.get(id);
  }
  decode(row) {
    if (!row) return null;
    return {
      taskId: row.id,
      request: JSON.parse(row.request),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      progress: JSON.parse(row.progress),
      artifact: row.artifact ? JSON.parse(row.artifact) : null,
      error: row.error ? JSON.parse(row.error) : null,
    };
  }
  get(id) {
    return this.decode(
      this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id),
    );
  }
  next() {
    return this.decode(
      this.db
        .prepare(
          "SELECT * FROM tasks WHERE status='queued' ORDER BY created_at,rowid LIMIT 1",
        )
        .get(),
    );
  }
  update(id, fields) {
    const old = this.get(id);
    if (!old) throw new EngineError('TASK_NOT_FOUND', '任务不存在', 404);
    const next = { ...old, ...fields };
    this.db
      .prepare(
        'UPDATE tasks SET status=?,updated_at=?,progress=?,artifact=?,error=? WHERE id=?',
      )
      .run(
        next.status,
        new Date().toISOString(),
        JSON.stringify(next.progress),
        next.artifact ? JSON.stringify(next.artifact) : null,
        next.error ? JSON.stringify(next.error) : null,
        id,
      );
    return this.get(id);
  }
  close() {
    this.db.close();
  }
}
