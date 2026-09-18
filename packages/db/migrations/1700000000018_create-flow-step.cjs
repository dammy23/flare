exports.up = (pgm) => {
  pgm.createTable('flow_step', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    flow_trace_id: { type: 'uuid', notNull: true, references: 'flow_trace', onDelete: 'CASCADE' },
    stage_name: { type: 'text', notNull: true },
    system: { type: 'text', notNull: true },
    dedup_key: { type: 'text', notNull: true },
    reported_ids: { type: 'jsonb', notNull: true, default: '[]' },
    tech_trace_id: { type: 'text' },
    issue_id: { type: 'uuid' },
    occurred_at: { type: 'timestamptz', notNull: true },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    status: { type: 'text', notNull: true, default: 'ok' },
  })
  pgm.addConstraint('flow_step', 'flow_step_dedup_key_unique', 'UNIQUE(dedup_key)')
  pgm.addConstraint('flow_step', 'flow_step_status_check', "CHECK (status IN ('ok', 'error'))")
  pgm.createIndex('flow_step', ['flow_trace_id', 'occurred_at'])
}

exports.down = (pgm) => {
  pgm.dropTable('flow_step')
}
