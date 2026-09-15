exports.up = (pgm) => {
  pgm.createTable('dashboard', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true, default: 'Default' },
    env_selector_default: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('dashboard', 'dashboard_project_id_unique', 'UNIQUE(project_id)')
}

exports.down = (pgm) => {
  pgm.dropTable('dashboard')
}
