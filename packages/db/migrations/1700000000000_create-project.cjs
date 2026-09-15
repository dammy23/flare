exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true })
  pgm.createTable('project', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true },
    public_key: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('project', 'project_slug_unique', 'UNIQUE(slug)')
  pgm.addConstraint('project', 'project_public_key_unique', 'UNIQUE(public_key)')
}

exports.down = (pgm) => {
  pgm.dropTable('project')
}
