exports.up = (pgm) => {
  pgm.createTable('raw_envelope', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    event_id: { type: 'text' },
    raw_bytes: { type: 'bytea', notNull: true },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('raw_envelope', ['project_id', 'received_at'])
}

exports.down = (pgm) => {
  pgm.dropTable('raw_envelope')
}
