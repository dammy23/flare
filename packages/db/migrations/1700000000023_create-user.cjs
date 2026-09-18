exports.up = (pgm) => {
  pgm.createTable('user', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email: { type: 'text', notNull: true },
    password_hash: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    is_admin: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('user', 'user_email_unique', 'UNIQUE(email)')
}

exports.down = (pgm) => {
  pgm.dropTable('user')
}
