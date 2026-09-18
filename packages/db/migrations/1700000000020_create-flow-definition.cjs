exports.up = (pgm) => {
  pgm.createTable('flow_definition', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
  })
}

exports.down = (pgm) => {
  pgm.dropTable('flow_definition')
}
