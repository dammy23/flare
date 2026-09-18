exports.up = (pgm) => {
  pgm.createTable('transaction_latency_rollup', {
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    environment_id: { type: 'uuid', notNull: true, references: 'environment', onDelete: 'CASCADE' },
    transaction_name: { type: 'text', notNull: true },
    hour_bucket: { type: 'timestamptz', notNull: true },
    p50_ms: { type: 'real', notNull: true },
    p95_ms: { type: 'real', notNull: true },
    p99_ms: { type: 'real', notNull: true },
    count: { type: 'integer', notNull: true },
  })
  pgm.addConstraint(
    'transaction_latency_rollup',
    'transaction_latency_rollup_pk',
    'PRIMARY KEY (project_id, environment_id, transaction_name, hour_bucket)'
  )
}

exports.down = (pgm) => {
  pgm.dropTable('transaction_latency_rollup')
}
