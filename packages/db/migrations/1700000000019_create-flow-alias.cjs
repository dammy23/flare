exports.up = (pgm) => {
  pgm.createTable('flow_alias', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    flow_trace_id: { type: 'uuid', notNull: true, references: 'flow_trace', onDelete: 'CASCADE' },
    system: { type: 'text', notNull: true },
    entity_id: { type: 'text', notNull: true },
    first_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('flow_alias', 'flow_alias_system_entity_id_unique', 'UNIQUE(system, entity_id)')
}

exports.down = (pgm) => {
  pgm.dropTable('flow_alias')
}
