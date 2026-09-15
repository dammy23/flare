exports.up = (pgm) => {
  pgm.createTable('release', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    version: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('release', 'release_project_version_unique', 'UNIQUE(project_id, version)')
}

exports.down = (pgm) => {
  pgm.dropTable('release')
}
