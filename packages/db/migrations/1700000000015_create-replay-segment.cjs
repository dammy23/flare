exports.up = (pgm) => {
  pgm.createTable('replay_segment', {
    replay_id: { type: 'uuid', notNull: true, references: 'replay', onDelete: 'CASCADE' },
    sequence: { type: 'integer', notNull: true },
    storage_key: { type: 'text', notNull: true },
    size_bytes: { type: 'integer', notNull: true },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('replay_segment', 'replay_segment_pk', 'PRIMARY KEY (replay_id, sequence)')
}

exports.down = (pgm) => {
  pgm.dropTable('replay_segment')
}
