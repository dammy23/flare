exports.up = (pgm) => {
  pgm.createTable('replay', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    environment_id: { type: 'uuid', notNull: true, references: 'environment', onDelete: 'CASCADE' },
    issue_id: { type: 'uuid', references: 'issue', onDelete: 'SET NULL' },
    session_id: { type: 'text', notNull: true },
    duration_ms: { type: 'integer', notNull: true, default: 0 },
    segment_count: { type: 'integer', notNull: true, default: 0 },
    error_count: { type: 'integer', notNull: true, default: 0 },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('replay', 'replay_project_session_unique', 'UNIQUE(project_id, session_id)')
}

exports.down = (pgm) => {
  pgm.dropTable('replay')
}
