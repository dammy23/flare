exports.up = (pgm) => {
  pgm.createTable('issue', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    fingerprint: { type: 'text', notNull: true },
    title: { type: 'text', notNull: true },
    culprit: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'unresolved' },
    first_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    times_seen: { type: 'integer', notNull: true, default: 1 },
    grouping_raw_components: { type: 'jsonb', notNull: true, default: '{}' },
  })
  pgm.addConstraint('issue', 'issue_project_fingerprint_unique', 'UNIQUE(project_id, fingerprint)')
  pgm.addConstraint(
    'issue',
    'issue_status_check',
    "CHECK (status IN ('unresolved', 'resolved', 'ignored'))"
  )
  pgm.createIndex('issue', ['project_id', 'status', 'last_seen'])
}

exports.down = (pgm) => {
  pgm.dropTable('issue')
}
