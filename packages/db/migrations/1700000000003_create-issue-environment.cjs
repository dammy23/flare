exports.up = (pgm) => {
  pgm.createTable('issue_environment', {
    issue_id: { type: 'uuid', notNull: true, references: 'issue', onDelete: 'CASCADE' },
    environment_id: { type: 'uuid', notNull: true, references: 'environment', onDelete: 'CASCADE' },
    first_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    times_seen: { type: 'integer', notNull: true, default: 1 },
  })
  pgm.addConstraint('issue_environment', 'issue_environment_pk', 'PRIMARY KEY (issue_id, environment_id)')
}

exports.down = (pgm) => {
  pgm.dropTable('issue_environment')
}
