exports.up = (pgm) => {
  pgm.createTable('flow_trace', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    status: { type: 'text', notNull: true, default: 'in_progress' },
    current_stage: { type: 'text' },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_activity_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    completed_at: { type: 'timestamptz' },
  })
  pgm.addConstraint(
    'flow_trace',
    'flow_trace_status_check',
    "CHECK (status IN ('in_progress', 'completed', 'stalled', 'abandoned'))"
  )
  pgm.createIndex('flow_trace', ['project_id', 'status'])
}

exports.down = (pgm) => {
  pgm.dropTable('flow_trace')
}
