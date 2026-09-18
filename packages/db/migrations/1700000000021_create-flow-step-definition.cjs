exports.up = (pgm) => {
  pgm.createTable('flow_step_definition', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    flow_definition_id: { type: 'uuid', notNull: true, references: 'flow_definition', onDelete: 'CASCADE' },
    stage_name: { type: 'text', notNull: true },
    sequence_order: { type: 'integer', notNull: true },
    expected_max_duration: { type: 'interval' },
    is_terminal: { type: 'boolean', notNull: true, default: false },
  })
  pgm.createIndex('flow_step_definition', ['flow_definition_id', 'sequence_order'])
}

exports.down = (pgm) => {
  pgm.dropTable('flow_step_definition')
}
