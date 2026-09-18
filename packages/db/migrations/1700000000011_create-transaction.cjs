exports.up = (pgm) => {
  pgm.createTable('transaction', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    environment_id: { type: 'uuid', notNull: true, references: 'environment', onDelete: 'CASCADE' },
    release_id: { type: 'uuid', references: 'release', onDelete: 'SET NULL' },
    trace_id: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    op: { type: 'text' },
    status: { type: 'text' },
    start_ts: { type: 'timestamptz', notNull: true },
    duration_ms: { type: 'integer', notNull: true },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('transaction', ['project_id', 'environment_id', 'name', 'start_ts'])
  pgm.createIndex('transaction', ['trace_id'])
}

exports.down = (pgm) => {
  pgm.dropTable('transaction')
}
