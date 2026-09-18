exports.up = (pgm) => {
  pgm.addColumn('flow_trace', {
    flow_definition_id: { type: 'uuid', references: 'flow_definition', onDelete: 'SET NULL' },
  })
}

exports.down = (pgm) => {
  pgm.dropColumn('flow_trace', 'flow_definition_id')
}
