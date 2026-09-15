exports.up = (pgm) => {
  pgm.createTable('event', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    issue_id: { type: 'uuid', notNull: true, references: 'issue', onDelete: 'CASCADE' },
    environment_id: { type: 'uuid', notNull: true, references: 'environment', onDelete: 'CASCADE' },
    event_id: { type: 'text', notNull: true },
    timestamp: { type: 'timestamptz', notNull: true },
    level: { type: 'text' },
    message: { type: 'text' },
    exception: { type: 'jsonb' },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('event', 'event_project_event_id_unique', 'UNIQUE(project_id, event_id)')
  pgm.createIndex('event', ['project_id', 'issue_id', 'timestamp'])
}

exports.down = (pgm) => {
  pgm.dropTable('event')
}
