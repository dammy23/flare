exports.up = (pgm) => {
  pgm.createTable('span', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    transaction_id: { type: 'uuid', notNull: true, references: 'transaction', onDelete: 'CASCADE' },
    trace_id: { type: 'text', notNull: true },
    span_id: { type: 'text', notNull: true },
    parent_span_id: { type: 'text' },
    op: { type: 'text' },
    description: { type: 'text' },
    start_ts: { type: 'timestamptz', notNull: true },
    duration_ms: { type: 'integer', notNull: true },
  })
  pgm.createIndex('span', ['trace_id'])
  pgm.createIndex('span', ['transaction_id'])
}

exports.down = (pgm) => {
  pgm.dropTable('span')
}
