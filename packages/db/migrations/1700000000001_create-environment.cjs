exports.up = (pgm) => {
  pgm.createTable('environment', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('environment', 'environment_project_name_unique', 'UNIQUE(project_id, name)')
}

exports.down = (pgm) => {
  pgm.dropTable('environment')
}
