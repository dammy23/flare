exports.up = (pgm) => {
  pgm.createTable('project_member', {
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'user', onDelete: 'CASCADE' },
    role: { type: 'text', notNull: true, default: 'member' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('project_member', 'project_member_pk', 'PRIMARY KEY (project_id, user_id)')
  pgm.addConstraint('project_member', 'project_member_role_check', "CHECK (role IN ('admin', 'member'))")
}

exports.down = (pgm) => {
  pgm.dropTable('project_member')
}
